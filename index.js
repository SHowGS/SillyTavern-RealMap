import { extension_settings, extensionTypes, renderExtensionTemplateAsync, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types, chat_metadata, setExtensionPrompt, extension_prompt_types, extension_prompt_roles, setExternalAbortController, deactivateSendButtons, activateSendButtons, getRequestHeaders } from '../../../../script.js';
import { t } from '../../../i18n.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { isAdmin } from '../../../user.js';
import { getRegexedString, regex_placement } from '../../regex/engine.js';
import { resetAmapCache } from './amap.js';
import {
    PLUGIN_LLM_MAX_TOKENS,
    combineLlmDebugReports,
    extractJsonObject,
    parseLlmResponsePayload,
    stringifyLlmResponse,
} from './llm-response.js';
import {
    getMovingProgress,
    getMovingRoutePosition,
    getPointAlongRoute,
    placeLabelsReferToSameLocation,
    projectPointToRoute,
} from './map-state.js';
import { setExtensionEnabledForChat, isExtensionEnabledForChat, getExtensionEnabledStateForChat, findLastAiMessage, getVisibleMessages, clearAllChatLocations, setChatState, getChatState, syncMesToSwipe, getCurrentPosition } from './state.js';
import { initMinimap, showMinimap, hideMinimap, refreshMap } from './minimap.js';
import {
    DEFAULT_SYSTEM_PROMPT,
    DEFAULT_ASSISTANT_REPLY,
    PREFLIGHT_SYSTEM_PROMPT,
    PREFLIGHT_ASSISTANT_REPLY,
    formatPluginLocation,
    renderContextPrompt,
    renderPreflightPrompt,
} from './prompts.js';
import { searchRankedPlaces, getRankedPoiLocation, normalizePlaceIntent, refinePlaceIntentFromNarrative, resolveNarrativePlace } from './place-search.js';
import {
    PREFLIGHT_TOTAL_TIMEOUT_MS,
    PreflightEventGate,
    formatPreflightContext,
    getPreflightSourceFingerprint,
    normalizePreflightIntent,
    queryRouteOptions,
    shouldRestoreGroupPreflight,
} from './preflight-route.js';

const MODULE_NAME = 'realmap';
const EXTENSION_MANIFEST_ID = 'third-party/SillyTavern-RealMap';
const EXTENSION_API_ID = '/SillyTavern-RealMap';
const LOADER_URL = 'https://webapi.amap.com/loader.js';
const REALMAP_INJECT_KEY = 'realmapLocationContext';
const REALMAP_PREFLIGHT_INJECT_KEY = 'realmapPreflightContext';
const MIN_INFERENCE_PLACE_SCORE = 80;
const VERSION_CHECK_TIMEOUT_MS = 60_000;
const EXTENSION_UPDATE_TIMEOUT_MS = 120_000;
const PLUGIN_CALL_CANCELLED = Symbol('realmapPluginCallCancelled');

let chatChangedTimer = null;
let chatChangedRunning = false;
let llmAbortController = null;
let preflightAbortController = null;
let preflightRunId = 0;
const preflightEventGate = new PreflightEventGate();
let postflightAbortController = null;
let postflightRunId = 0;
let extensionUpdateInProgress = false;
const preflightLlmDebugByMessage = new WeakMap();

/**
 * @typedef {Object} RealMapSettings
 * @property {string} key Amap JS API key
 * @property {string} securityCode Amap securityJsCode
 * @property {string} llmSource LLM provider id
 * @property {string} llmCustomUrl Custom OpenAI-compatible base URL
 * @property {string} llmApiKey LLM API key
 * @property {string} llmModel LLM model id
 */

const DEFAULT_SETTINGS = {
    key: '',
    securityCode: '',
    llmSource: 'openai',
    llmCustomUrl: '',
    llmApiKey: '',
    llmModel: '',
};

function ensureSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    const s = extension_settings[MODULE_NAME];
    // 提示词统一由prompts.js维护，清理旧版可编辑提示词设置。
    const legacyPromptKeys = [
        'llmPrompt',
        'llmAssistantReply',
        'llmPrefill',
        'llmPromptSystem',
        'llmPromptSuffix',
        'llmPromptJsonSchema',
        'llmPromptToolSpec',
        'llmPromptFallback',
    ];
    const hasLegacyPromptSettings = legacyPromptKeys.some(key => Object.prototype.hasOwnProperty.call(s, key));
    legacyPromptKeys.forEach(key => delete s[key]);
    if (hasLegacyPromptSettings) {
        saveSettingsDebounced();
    }
    // 仅对缺失字段（undefined）填默认；已存在的空字符串视为用户主动清空，保留。
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) {
            s[k] = DEFAULT_SETTINGS[k];
        }
    }
    return s;
}

let amapPromise = null;

async function loadAmap() {
    const s = ensureSettings();
    if (!s.key) {
        throw new Error(t`Amap key is not configured. Open the Map Service settings and paste your JS API key.`);
    }
    if (amapPromise) {
        return amapPromise;
    }
    amapPromise = (async () => {
        window._AMapSecurityConfig = { securityJsCode: s.securityCode };
        if (typeof AMapLoader === 'undefined') {
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = LOADER_URL;
                script.onload = resolve;
                script.onerror = () => reject(new Error(t`Failed to load AMap loader from ${LOADER_URL}`));
                document.head.appendChild(script);
            });
        }
        return await AMapLoader.load({
            key: s.key,
            version: '2.0',
            plugins: [
                'AMap.Scale',
                'AMap.ToolBar',
                'AMap.Geocoder',
                'AMap.AutoComplete',
                'AMap.PlaceSearch',
                'AMap.Weather',
                'AMap.Driving',
                'AMap.Walking',
                'AMap.Transfer',
                'AMap.Riding',
                'AMap.DistrictSearch',
                'AMap.Geolocation',
            ],
        });
    })();
    return amapPromise;
}

const LLM_BASE_URLS = {
    openai: 'https://api.openai.com/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    deepseek: 'https://api.deepseek.com/v1',
    custom: '',
};

function getLlmBaseUrl(s) {
    return s.llmSource === 'custom' ? (s.llmCustomUrl || '').trim().replace(/\/$/, '') : LLM_BASE_URLS[s.llmSource] || '';
}

async function refreshLlmModels() {
    const s = ensureSettings();
    const baseUrl = getLlmBaseUrl(s);
    const dropdown = document.getElementById('realmap_llm_model');
    if (!(dropdown instanceof HTMLSelectElement)) return;
    if (!baseUrl) {
        toastr.warning(t`请先填写 Base URL（或选择非自定义的 API 类型）。`);
        return;
    }
    if (!s.llmApiKey) {
        toastr.warning(t`请先填写 API Key。`);
        return;
    }
    try {
        const resp = await fetch(`${baseUrl}/models`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${s.llmApiKey}` },
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const models = Array.isArray(data?.data) ? data.data.map(m => m.id).filter(Boolean) : [];
        // 保留当前选中值
        const prev = s.llmModel;
        dropdown.innerHTML = '';
        models.forEach(id => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = id;
            dropdown.add(opt);
        });
        if (models.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '（无可用模型）';
            dropdown.add(opt);
        }
        if (prev && models.includes(prev)) {
            dropdown.value = prev;
            s.llmModel = prev;
        } else {
            s.llmModel = String(dropdown.value);
        }
        saveSettingsDebounced();
        toastr.success(t`已获取 ${models.length} 个模型。`);
    } catch (e) {
        console.error('[realmap] refresh models failed', e);
        toastr.error(t`获取模型失败（可能是 CORS 或 Key/URL 问题）：${e.message}`);
    }
}

async function testConnection() {
    const s = ensureSettings();
    console.log('[realmap] testConnection settings:', { hasKey: !!s.key, hasSecurity: !!s.securityCode, keyLen: s.key.length });
    try {
        const AMap = await loadAmap();
        // 用一个隐藏容器创建真实地图实例，监听 complete 事件以验证 key/securityCode 有效性
        let container = document.getElementById('realmap_test_container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'realmap_test_container';
            container.style.cssText = 'position:fixed;left:-9999px;top:0;width:300px;height:300px;';
            document.body.appendChild(container);
        }
        let resolved = false;
        const map = new AMap.Map(container, { zoom: 12 });
        map.on('complete', () => {
            resolved = true;
            map.destroy();
            toastr.success(t`高德地图连接成功（key 与安全密钥有效）。`);
        });
        map.on('error', (e) => {
            resolved = true;
            map.destroy();
            toastr.error(t`高德地图加载失败：${e?.info || JSON.stringify(e)}`);
        });
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                map.destroy();
                toastr.info(t`高德地图已加载，但瓦片 complete 事件超时（key 可能受限）。`);
            }
        }, 8000);
    } catch (e) {
        toastr.error(String(t`高德地图连接失败：`) + e.message);
    }
}

async function getManifestVersion() {
    try {
        const response = await fetch(new URL('./manifest.json', import.meta.url), { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const manifest = await response.json();
        return typeof manifest?.version === 'string' ? manifest.version : '';
    } catch (error) {
        console.warn('[realmap] failed to read manifest version', error);
        return '';
    }
}

function setUpdateButtonState({ available = false, disabled = false, title = '' } = {}) {
    const button = $('#realmap_update_btn');
    button
        .toggleClass('realmap_update_available', available)
        .prop('disabled', disabled)
        .attr('title', title || (available ? '发现新版本，点击更新' : '检查并更新现实地图'));
}

function isGlobalExtension() {
    return extensionTypes[EXTENSION_MANIFEST_ID] === 'global';
}

function canUpdateExtension() {
    return !isGlobalExtension() || isAdmin();
}

async function checkRealMapVersion() {
    const versionElement = document.getElementById('realmap_version_value');
    if (!versionElement) return;

    versionElement.textContent = '正在检查...';
    setUpdateButtonState({ disabled: true });
    const manifestVersionPromise = getManifestVersion();

    try {
        const response = await fetch('/api/extensions/version', {
            method: 'POST',
            signal: AbortSignal.timeout(VERSION_CHECK_TIMEOUT_MS),
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName: EXTENSION_API_ID,
                global: isGlobalExtension(),
            }),
        });
        if (!response.ok) {
            const message = await response.text();
            throw new Error(message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        if (typeof data.isUpToDate !== 'boolean') {
            throw new Error('版本接口返回了无效状态');
        }
        const manifestVersion = await manifestVersionPromise;
        const versionParts = [];
        if (manifestVersion) {
            versionParts.push(`v${manifestVersion}`);
        }
        if (data.currentBranchName && data.currentCommitHash) {
            versionParts.push(`${data.currentBranchName}-${String(data.currentCommitHash).slice(0, 7)}`);
        }

        const hasUpdate = data.isUpToDate === false;
        const canUpdate = canUpdateExtension();
        versionParts.push(hasUpdate
            ? (canUpdate ? '有新版本' : '有新版本（需要管理员更新）')
            : '已是最新版');
        versionElement.textContent = versionParts.join(' · ');
        setUpdateButtonState({
            available: hasUpdate,
            disabled: !canUpdate,
            title: !canUpdate ? '全局扩展只能由管理员更新' : '',
        });
    } catch (error) {
        const manifestVersion = await manifestVersionPromise;
        versionElement.textContent = manifestVersion
            ? `v${manifestVersion} · 检查更新失败`
            : '检查更新失败';
        const canUpdate = canUpdateExtension();
        setUpdateButtonState({
            disabled: !canUpdate,
            title: !canUpdate ? '全局扩展只能由管理员更新' : '',
        });
        console.warn('[realmap] version check failed', error);
    }
}

async function updateRealMapExtension() {
    if (extensionUpdateInProgress) return;
    if (!canUpdateExtension()) {
        toastr.error(t`全局扩展只能由管理员更新。`);
        return;
    }

    extensionUpdateInProgress = true;
    const button = $('#realmap_update_btn');
    const icon = button.find('i');
    button.prop('disabled', true);
    icon.removeClass('fa-download').addClass('fa-spinner fa-spin');

    try {
        const response = await fetch('/api/extensions/update', {
            method: 'POST',
            signal: AbortSignal.timeout(EXTENSION_UPDATE_TIMEOUT_MS),
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName: EXTENSION_API_ID,
                global: isGlobalExtension(),
            }),
        });
        if (!response.ok) {
            const message = await response.text();
            throw new Error(message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        if (typeof data.isUpToDate !== 'boolean') {
            throw new Error('更新接口返回了无效状态');
        }
        if (data.isUpToDate) {
            toastr.success(t`现实地图已是最新版。`);
        } else {
            const commit = data.shortCommitHash ? `（${data.shortCommitHash}）` : '';
            toastr.success(t`现实地图已更新${commit}，请刷新页面以应用更新。`);
        }
        await checkRealMapVersion();
    } catch (error) {
        console.error('[realmap] extension update failed', error);
        toastr.error(t`现实地图更新失败：${error.message}`);
    } finally {
        extensionUpdateInProgress = false;
        icon.removeClass('fa-spinner fa-spin').addClass('fa-download');
        button.prop('disabled', !canUpdateExtension());
    }
}

function bindSettings() {
    const s = ensureSettings();
    $('#realmap_key').val(s.key).on('input', function () {
        s.key = String($(this).val());
        amapPromise = null;
        saveSettingsDebounced();
    });
    $('#realmap_security_code').val(s.securityCode).on('input', function () {
        s.securityCode = String($(this).val());
        amapPromise = null;
        saveSettingsDebounced();
    });
    $('#realmap_test_connection').on('click', () => void testConnection());

    $('#realmap_llm_source').val(s.llmSource).on('change', function () {
        s.llmSource = String($(this).val());
        toggleLlmCustomUrl();
        saveSettingsDebounced();
    });
    $('#realmap_llm_custom_url').val(s.llmCustomUrl).on('input', function () {
        s.llmCustomUrl = String($(this).val());
        saveSettingsDebounced();
    });
    $('#realmap_llm_api_key').val(s.llmApiKey).on('input', function () {
        s.llmApiKey = String($(this).val());
        saveSettingsDebounced();
    });
    const modelDropdown = $('#realmap_llm_model');
    if (s.llmModel && !modelDropdown.find(`option[value="${s.llmModel}"]`).length) {
        modelDropdown.append(`<option value="${s.llmModel}">${s.llmModel}</option>`);
    }
    modelDropdown.val(s.llmModel).on('change', function () {
        s.llmModel = String($(this).val());
        saveSettingsDebounced();
    });
    $('#realmap_llm_refresh_models').on('click', () => void refreshLlmModels());
    $('#realmap_update_btn').on('click', () => void updateRealMapExtension());
    toggleLlmCustomUrl();

}

function toggleLlmCustomUrl() {
    $('#realmap_llm_custom_url_block').toggle($('#realmap_llm_source').val() === 'custom');
}

export async function init() {
    const settingsHtml = await renderExtensionTemplateAsync('third-party/SillyTavern-RealMap', 'settings');
    $('#extensions_settings').append(settingsHtml);
    bindSettings();
    void checkRealMapVersion();
    injectMinimapHtml();
    await initMinimap({ onDisableClick: handleDisableClick, onRejudge: handleRejudge });
    eventSource.on(event_types.GENERATION_STARTED, onPreflightGenerationStarted);
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, onPreflightGenerationAfterCommands);
    eventSource.on(event_types.MESSAGE_SENT, onPreflightMessageSent);
    eventSource.on(event_types.GENERATION_ENDED, onPreflightGenerationEnded);
    eventSource.on(event_types.GENERATION_STOPPED, onPreflightGenerationStopped);
    eventSource.on(event_types.GROUP_WRAPPER_STARTED, onPreflightGroupStarted);
    eventSource.on(event_types.GROUP_WRAPPER_FINISHED, onPreflightGroupFinished);
    eventSource.on(event_types.CHAT_CHANGED, onPreflightChatChanged);
    eventSource.on(event_types.CHAT_CHANGED, debouncedOnChatChanged);
    eventSource.on(event_types.MESSAGE_DELETED, debouncedOnChatChanged);
    eventSource.on(event_types.MESSAGE_EDITED, debouncedOnChatChanged);
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, onAiMessage);
    onChatChanged();
    $('#realmap_enable_btn').on('click', () => void handleEnableFromSettings());
    console.debug('[realmap] initialized');
}

function clearPreflightInjection() {
    setExtensionPrompt(
        REALMAP_PREFLIGHT_INJECT_KEY,
        '',
        extension_prompt_types.IN_CHAT,
        0,
        false,
        extension_prompt_roles.SYSTEM,
    );
}

function cancelPreflightWork({ clearInjection = true, disarm = true } = {}) {
    preflightRunId += 1;
    if (preflightAbortController) {
        preflightAbortController.abort();
        preflightAbortController = null;
    }
    if (disarm) preflightEventGate.disarm();
    if (clearInjection) clearPreflightInjection();
}

function cancelPostflightWork({ detach = false } = {}) {
    postflightRunId += 1;
    const controller = postflightAbortController;
    if (controller && !controller.signal.aborted) controller.abort();
    if (detach && postflightAbortController === controller) {
        postflightAbortController = null;
    }
}

function cancelAllPluginWork({ detachPostflight = false } = {}) {
    cancelPreflightWork();
    cancelPostflightWork({ detach: detachPostflight });
    if (llmAbortController && !llmAbortController.signal.aborted) {
        llmAbortController.abort();
    }
}

function setPreflightInjection(metadata) {
    const context = formatPreflightContext(metadata);
    setExtensionPrompt(
        REALMAP_PREFLIGHT_INJECT_KEY,
        context,
        extension_prompt_types.IN_CHAT,
        0,
        false,
        extension_prompt_roles.SYSTEM,
    );
    return context;
}

function getLatestUserPreflight() {
    const chat = getContext()?.chat;
    if (!Array.isArray(chat)) return null;
    const message = [...chat].reverse().find(item => item?.is_user && !item?.is_system);
    const metadata = message?.extra?.realmap_preflight;
    const sourceMatches = metadata?.source_fingerprint
        === getPreflightSourceFingerprint(message?.mes);
    return metadata?.v === 1 && sourceMatches && Array.isArray(metadata.routes)
        ? metadata
        : null;
}

function onPreflightGenerationStarted(type, _params, dryRun) {
    if (dryRun) return;
    cancelPostflightWork({ detach: true });
    const isReuseGeneration = type === 'regenerate' || type === 'swipe';
    if (isReuseGeneration) {
        cancelPreflightWork();
        const metadata = getLatestUserPreflight();
        if (metadata) setPreflightInjection(metadata);
        return;
    }

    const hasPendingUserText = (type === undefined || type === 'normal')
        && Boolean(String($('#send_textarea').val() ?? '').trim());
    if (!preflightEventGate.groupActive || hasPendingUserText || ![undefined, 'normal'].includes(type)) {
        cancelPreflightWork();
    }
}

function onPreflightGenerationAfterCommands(type, params, dryRun) {
    const armed = preflightEventGate.arm({
        type,
        automaticTrigger: params?.automatic_trigger,
        dryRun,
        userText: $('#send_textarea').val(),
    });
    if (armed) clearPreflightInjection();
}

async function onPreflightMessageSent(messageId) {
    const ctx = getContext();
    const chat = ctx?.chat;
    const message = Array.isArray(chat) ? chat[Number(messageId)] : null;
    if (!preflightEventGate.consume(message?.is_user && !message?.is_system)) return;
    await runPreflightForUserMessage(ctx, chat, message);
}

function onPreflightGenerationEnded() {
    if (!preflightEventGate.groupActive) cancelPreflightWork();
}

function onPreflightGenerationStopped() {
    cancelAllPluginWork();
}

function onPreflightGroupStarted({ type } = {}) {
    preflightEventGate.startGroup();
    cancelPostflightWork({ detach: true });
    cancelPreflightWork({ clearInjection: false });
    if (shouldRestoreGroupPreflight({
        type,
        userText: $('#send_textarea').val(),
    })) {
        const metadata = getLatestUserPreflight();
        if (metadata) setPreflightInjection(metadata);
    }
}

function onPreflightGroupFinished() {
    preflightEventGate.finishGroup();
    cancelPreflightWork();
}

function onPreflightChatChanged() {
    preflightEventGate.finishGroup();
    cancelAllPluginWork();
}

function getLocationSnapshotFromState(state) {
    if (!state) return null;
    if (Number.isFinite(state.lng) && Number.isFinite(state.lat)) {
        return {
            lng: state.lng,
            lat: state.lat,
            label: state.label || '当前位置',
        };
    }
    if (state.mode === 'moving'
        && Number.isFinite(state.from?.lng)
        && Number.isFinite(state.from?.lat)) {
        const currentPosition = getMovingRoutePosition(state);
        if (!currentPosition) return null;
        return {
            lng: currentPosition.lng,
            lat: currentPosition.lat,
            label: state.from.label || '当前位置',
        };
    }
    return null;
}

function getCurrentLocationSnapshot() {
    return getLocationSnapshotFromState(getChatState());
}

function getPreviousAiMessage(chat, userMessage) {
    const index = chat.indexOf(userMessage);
    if (index < 0) return null;
    return chat.slice(0, index).reverse().find(item => item && !item.is_user && !item.is_system) || null;
}

function getPluginLlmMessageText(chat, message) {
    if (!message || typeof message.mes !== 'string') return '';
    const promptMessages = chat.filter(item => item && !item.is_system && typeof item.mes === 'string');
    const messageIndex = promptMessages.indexOf(message);
    const depth = messageIndex < 0 ? undefined : promptMessages.length - messageIndex - 1;
    const placement = message.is_user ? regex_placement.USER_INPUT : regex_placement.AI_OUTPUT;
    try {
        return getRegexedString(message.mes, placement, {
            isPrompt: true,
            depth,
        });
    } catch (error) {
        console.warn('[realmap] failed to apply active prompt regex', error);
        return message.mes;
    }
}

function waitBeforeDeadline(promise, deadline, fallback = null, signal = null) {
    const timeoutMs = Math.max(0, deadline - Date.now());
    if (timeoutMs <= 0 || signal?.aborted) return Promise.resolve(fallback);
    return new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const onAbort = () => finish(fallback);
        const finish = (value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
        };
        timer = setTimeout(() => finish(fallback), timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then(finish, () => finish(fallback));
    });
}

function waitForSignal(promise, signal, fallback = null) {
    if (signal?.aborted) return Promise.resolve(fallback);
    return new Promise((resolve) => {
        let settled = false;
        const onAbort = () => finish(fallback);
        const finish = (value) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then(finish, () => finish(fallback));
    });
}

function runAmapCallbackWithSignal(start, signal, fallback = null) {
    if (signal?.aborted) return Promise.resolve(fallback);
    return new Promise((resolve) => {
        let settled = false;
        const onAbort = () => finish(fallback);
        const finish = (value) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            start(finish);
        } catch (_) {
            finish(fallback);
        }
    });
}

async function runPreflightForUserMessage(ctx, chat, message) {
    const settings = ensureSettings();
    if (!isExtensionEnabledForChat()
        || !settings.key
        || !settings.llmApiKey
        || !settings.llmModel) {
        clearPreflightInjection();
        return;
    }

    cancelPreflightWork({ clearInjection: true, disarm: false });
    const runId = preflightRunId;
    const runController = new AbortController();
    preflightAbortController = runController;
    const deadline = Date.now() + PREFLIGHT_TOTAL_TIMEOUT_MS;
    const current = getCurrentLocationSnapshot();
    const previousAi = getPreviousAiMessage(chat, message);
    const previousAiText = getPluginLlmMessageText(chat, previousAi);
    const currentUserText = getPluginLlmMessageText(chat, message);
    const messages = [
        { role: 'system', content: PREFLIGHT_SYSTEM_PROMPT },
        { role: 'assistant', content: PREFLIGHT_ASSISTANT_REPLY },
        {
            role: 'user',
            content: renderPreflightPrompt({
                currentLocation: formatPluginLocation(current),
                previousAi: previousAiText || '无',
                currentUser: currentUserText || '无',
            }),
        },
    ];

    preflightLlmDebugByMessage.delete(message);
    const rawIntent = await callPluginLlm(settings, messages, {
        maxTokens: PLUGIN_LLM_MAX_TOKENS,
        showDebug: false,
        manageUi: false,
        timeoutMs: Math.max(0, deadline - Date.now()),
        abortController: runController,
        debugLabel: '正文前信息补充LLM',
        onDebugReport: report => preflightLlmDebugByMessage.set(message, report),
    });
    if (runId !== preflightRunId || getContext()?.chat !== chat) return;

    const intent = normalizePreflightIntent(rawIntent, [currentUserText]);
    if (intent.action !== 'route') {
        console.debug('[realmap] preflight: no movement intent');
        clearPreflightInjection();
        return;
    }

    const AMap = await waitBeforeDeadline(loadAmap(), deadline, null, runController.signal);
    if (!AMap || runId !== preflightRunId || getContext()?.chat !== chat) return;

    let from = current;
    if (intent.from) {
        from = await waitBeforeDeadline(
            resolvePlaceCandidate(AMap, intent.from, current, runController.signal),
            deadline,
            null,
            runController.signal,
        );
    }
    if (!from) {
        console.debug('[realmap] preflight: unresolved origin');
        clearPreflightInjection();
        return;
    }

    const to = await waitBeforeDeadline(
        resolvePlaceCandidate(AMap, intent.to, from, runController.signal),
        deadline,
        null,
        runController.signal,
    );
    if (!to || runId !== preflightRunId || getContext()?.chat !== chat) {
        console.debug('[realmap] preflight: unresolved destination');
        clearPreflightInjection();
        return;
    }

    const routes = await queryRouteOptions(AMap, {
        from,
        to,
        modes: intent.modes,
        deadline,
        signal: runController.signal,
    });
    if (runId !== preflightRunId || getContext()?.chat !== chat) return;
    if (!routes.length) {
        console.debug('[realmap] preflight: no route result');
        clearPreflightInjection();
        return;
    }

    const metadata = {
        v: 1,
        captured_at: Date.now(),
        source_fingerprint: getPreflightSourceFingerprint(message.mes),
        intent,
        from: {
            label: from.name || from.label || '当前位置',
            lng: from.lng,
            lat: from.lat,
        },
        to: {
            label: to.name || to.label || intent.to.full,
            lng: to.lng,
            lat: to.lat,
        },
        routes,
    };
    if (!message.extra) message.extra = {};
    message.extra.realmap_preflight = metadata;
    const context = setPreflightInjection(metadata);
    if (!context) return;

    console.debug('[realmap] preflight route context', metadata);
    if (typeof ctx.saveChat === 'function') {
        void Promise.resolve(ctx.saveChat()).catch(error => {
            console.warn('[realmap] failed to save preflight metadata', error);
        });
    }
}

function injectMinimapHtml() {
    if (!$('#realmap_minimap').length) {
        const html = `
<div id="realmap_minimap" style="display:none;">
    <div id="realmap_titlebar" class="realmap_titlebar">
        <span class="realmap_title_text">现实地图</span>
        <div id="realmap_rejudge_btn" class="realmap_link_btn">重新判断</div>
        <div id="realmap_disable_btn" class="realmap_link_btn">禁用</div>
    </div>
    <div id="realmap_map_container">
        <div id="realmap_mm_fullscreen_btn" class="realmap_fullscreen_btn" title="全屏">⛶</div>
        <div class="realmap_layer_ctl">
            <select id="realmap_mm_layer_select" class="realmap_layer_select">
                <option value="normal">标准</option>
                <option value="satellite">卫星</option>
            </select>
            <div id="realmap_mm_layer_btn" class="realmap_layer_btn" style="display:none">路网</div>
            <div id="realmap_mm_panorama_btn" class="realmap_panorama_btn" title="在百度街景中打开">全景</div>
        </div>
        <div class="realmap_zoom_ctl">
            <div id="realmap_zoom_in" class="realmap_zoom_btn">+</div>
            <div id="realmap_zoom_out" class="realmap_zoom_btn">−</div>
        </div>
        <div id="realmap_clean_state_hint" class="realmap_hint">请开始游玩</div>
    </div>
</div>`;
        $('#movingDivs').append(html);
    }
}

function isChatOpen() {
    const ctx = getContext();
    return (ctx.characterId !== undefined) || Boolean(ctx.groupId);
}

function debouncedOnChatChanged() {
    clearTimeout(chatChangedTimer);
    chatChangedTimer = setTimeout(async () => {
        if (chatChangedRunning) return;
        chatChangedRunning = true;
        try {
            await onChatChanged();
        } finally {
            chatChangedRunning = false;
            updateExtensionPrompt();
        }
    }, 100);
}

async function onChatChanged() {
    refreshEnableButton();
    if (!isChatOpen()) {
        hideMinimap();
        return;
    }
    const enabledState = getExtensionEnabledStateForChat();
    if (enabledState === true) {
        // 刷新后 chat_metadata 可能过期/为空，从最后一条 AI 消息同步位置
        const last = findLastAiMessage();
        if (last?.message?.extra?.realmap) {
            setChatState(last.message.extra.realmap);
        }
        await refreshMap();
        showMinimap();
        return;
    }
    if (enabledState === false) {
        hideMinimap();
        return;
    }
    const last = findLastAiMessage();
    if (last?.message?.extra?.realmap) {
        setExtensionEnabledForChat(true);
        setChatState(last.message.extra.realmap);
        await refreshMap();
        showMinimap();
        return;
    }
    if (last) {
        const ok = await askEnable('是否在本聊天启用现实地图？');
        if (!ok) {
            setExtensionEnabledForChat(false, { immediate: true });
            hideMinimap();
            return;
        }
        setExtensionEnabledForChat(true);
        const inferred = await inferLocationFromVisible();
        if (inferred === PLUGIN_CALL_CANCELLED) return;
        await refreshMap();
        showMinimap();
    } else {
        const ok = await askEnable('是否启用现实地图？');
        if (!ok) {
            setExtensionEnabledForChat(false, { immediate: true });
            hideMinimap();
            return;
        }
        setExtensionEnabledForChat(true);
        setChatState(null);
        await refreshMap();
        showMinimap();
    }
}

async function onAiMessage(_messageId) {
    if (!isChatOpen() || !isExtensionEnabledForChat()) return;
    const loc = await inferLocationFromVisible();
    if (loc === PLUGIN_CALL_CANCELLED) return;
    await refreshMap();
    updateExtensionPrompt();
}

async function handleRejudge() {
    if (!isChatOpen() || !isExtensionEnabledForChat()) return;
    const loc = await inferLocationFromVisible();
    if (loc === PLUGIN_CALL_CANCELLED) return;
    await refreshMap();
    updateExtensionPrompt();
}

function refreshEnableButton() {
    const $btn = $('#realmap_enable_block');
    if (!isChatOpen()) {
        $btn.hide();
        return;
    }
    $btn.show();
    const enabled = isExtensionEnabledForChat();
    $('#realmap_enable_btn').toggleClass('disabled', enabled).css('opacity', enabled ? 0.5 : 1).prop('disabled', enabled);
    $('#realmap_enable_btn').text(enabled ? '现实地图已启用' : '启用现实地图');
}

async function handleEnableFromSettings() {
    if (!isChatOpen()) return;
    if (isExtensionEnabledForChat()) return;
    setExtensionEnabledForChat(true, { immediate: true });
    const last = findLastAiMessage();
    if (last) {
        const loc = await inferLocationFromVisible();
        if (loc === PLUGIN_CALL_CANCELLED) return;
    }
    await refreshMap();
    showMinimap();
    refreshEnableButton();
}

async function handleDisableClick() {
    const clearId = 'realmap_clear_history';
    const result = await Popup.show.confirm(
        '禁用现实地图？',
        '是否在本聊天禁用现实地图？（您可以在拓展页再次启用）',
        {
            customInputs: [{
                type: 'checkbox',
                label: '同时清除本聊天的历史地图数据（不会对正文有任何影响）',
                id: clearId,
                defaultState: false,
            }],
            onClose: async (popup) => {
                if (popup.result !== POPUP_RESULT.AFFIRMATIVE) return;
                const alsoClear = Boolean(popup.inputResults.get(clearId));
                setExtensionEnabledForChat(false, { immediate: true });
                cancelAllPluginWork();
                if (alsoClear) {
                    clearAllChatLocations();
                }
                hideMinimap();
                refreshEnableButton();
            },
        },
    );
    void result;
}

async function askEnable(text) {
    const r = await Popup.show.confirm('现实地图', text);
    return r === POPUP_RESULT.AFFIRMATIVE;
}

async function inferLocationFromVisible() {
    const s = ensureSettings();
    if (!s.llmApiKey || !s.llmModel) {
        return copyPrevLocation();
    }

    const ctx = getContext();
    const chat = ctx?.chat;
    if (!Array.isArray(chat) || chat.length < 2) return null;

    const last = findLastAiMessage();
    if (!last) return null;

    cancelPostflightWork({ detach: true });
    const runId = postflightRunId;
    const controller = new AbortController();
    postflightAbortController = controller;
    deactivateSendButtons();

    try {
        const roundContext = getRoundContext(chat);
        const regexedNarrative = {
            previousAi: getPluginLlmMessageText(chat, roundContext.prevAiMes),
            currentUser: getPluginLlmMessageText(chat, roundContext.curUserMes),
            currentAi: getPluginLlmMessageText(chat, roundContext.curAiMes),
        };
        const messages = buildLlmMessages(chat, roundContext, regexedNarrative);
        const preflightDebugReport = preflightLlmDebugByMessage.get(roundContext.curUserMes) || '';
        const rawResult = await callPluginLlm(s, messages, {
            maxTokens: PLUGIN_LLM_MAX_TOKENS,
            manageUi: false,
            registerExternalAbort: false,
            abortController: controller,
            debugLabel: '输出后位置推断LLM',
            prependDebugReports: [preflightDebugReport],
        });
        if (controller.signal.aborted
            || runId !== postflightRunId
            || getContext()?.chat !== chat) {
            return PLUGIN_CALL_CANCELLED;
        }

        const llmResult = refineLlmLocationResult(
            rawResult,
            [regexedNarrative.currentAi, regexedNarrative.currentUser],
        );
        if (!llmResult) return copyPrevLocation();

        const loc = await resolveLocation(llmResult, last, controller.signal);
        if (controller.signal.aborted
            || runId !== postflightRunId
            || getContext()?.chat !== chat) {
            return PLUGIN_CALL_CANCELLED;
        }
        return loc;
    } finally {
        if (postflightAbortController === controller) {
            postflightAbortController = null;
            activateSendButtons();
        }
    }
}

function getRoundContext(chat) {
    const visible = chat.filter(m => !m?.is_system && typeof m?.mes === 'string');
    const lastIdx = visible.length - 1;
    const prevAiMes = visible.slice(0, lastIdx).reverse().find(m => !m.is_user);
    const curAiMes = visible[lastIdx];
    const curUserMes = visible.slice(0, lastIdx).reverse().find(m => m.is_user);
    return { prevAiMes, curAiMes, curUserMes };
}

function buildLlmMessages(chat, roundContext = getRoundContext(chat), regexedNarrative = null) {
    const { prevAiMes, curAiMes, curUserMes } = roundContext;
    const narrative = regexedNarrative || {
        previousAi: getPluginLlmMessageText(chat, prevAiMes),
        currentUser: getPluginLlmMessageText(chat, curUserMes),
        currentAi: getPluginLlmMessageText(chat, curAiMes),
    };

    const prevLoc = prevAiMes?.extra?.realmap;
    const previousLocation = formatPluginLocation(getLocationSnapshotFromState(prevLoc));
    const contextPrompt = renderContextPrompt({
        previousLocation,
        previousAi: narrative.previousAi || '无',
        currentUser: narrative.currentUser || '无',
        currentAi: narrative.currentAi || '无',
    });

    const messages = [
        { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
        { role: 'assistant', content: DEFAULT_ASSISTANT_REPLY },
        { role: 'user', content: contextPrompt },
    ];
    return messages;
}

function refineLlmLocationResult(result, narrativeTexts) {
    if (!result || result.action === 'null') return result;
    if (result.action === 'idle' && result.place) {
        return {
            ...result,
            place: refinePlaceIntentFromNarrative(result.place, narrativeTexts),
        };
    }
    if (result.action === 'moving' && result.from && result.to) {
        return {
            ...result,
            from: refinePlaceIntentFromNarrative(result.from, narrativeTexts),
            to: refinePlaceIntentFromNarrative(result.to, narrativeTexts),
        };
    }
    return result;
}

function getNarrativeElapsedMinutes(result) {
    const value = Number(result?.elapsed_min);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.round(value * 10) / 10;
}

async function callPluginLlm(s, messages, {
    maxTokens = PLUGIN_LLM_MAX_TOKENS,
    showDebug = true,
    manageUi = true,
    timeoutMs = null,
    registerExternalAbort = manageUi,
    abortController = null,
    debugLabel = '插件LLM',
    prependDebugReports = [],
    onDebugReport = null,
} = {}) {
    const baseUrl = getLlmBaseUrl(s);
    if (!baseUrl) return null;
    if (timeoutMs !== null && timeoutMs <= 0) return null;

    const controller = abortController || new AbortController();
    let timeout = null;
    let timedOut = false;
    if (registerExternalAbort) {
        llmAbortController = controller;
        setExternalAbortController(controller);
    }
    if (manageUi) deactivateSendButtons();
    if (timeoutMs > 0) {
        timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
    }

    let result = null;
    let rawContent = '';
    let aborted = false;
    let errorMsg = '';
    let responseText = '';
    let responseData = null;
    let httpStatus = 0;
    let httpStatusText = '';
    let requestId = '';
    let contentSource = '';
    let finishReason = '';
    let responseModel = '';
    let usage = null;

    try {
        const resp = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${s.llmApiKey}`,
            },
            body: JSON.stringify({
                model: s.llmModel,
                messages,
                temperature: 0.1,
                max_tokens: maxTokens,
            }),
            signal: controller.signal,
        });
        httpStatus = resp.status;
        httpStatusText = resp.statusText || '';
        requestId = resp.headers.get('x-request-id')
            || resp.headers.get('request-id')
            || resp.headers.get('x-trace-id')
            || resp.headers.get('cf-ray')
            || '';
        responseText = await resp.text();
        if (responseText) {
            try {
                responseData = JSON.parse(responseText);
            } catch (error) {
                if (resp.ok) {
                    errorMsg = `响应JSON解析失败：${error.message}`;
                }
            }
        }

        const parsedResponse = parseLlmResponsePayload(responseData);
        rawContent = parsedResponse.rawContent;
        contentSource = parsedResponse.contentSource;
        finishReason = parsedResponse.finishReason;
        responseModel = parsedResponse.model;
        usage = parsedResponse.usage;

        if (!resp.ok) {
            const detail = parsedResponse.apiError || responseText.trim() || httpStatusText;
            errorMsg = `HTTP ${resp.status}${detail ? `：${detail}` : ''}`;
        } else {
            if (parsedResponse.apiError) {
                errorMsg = parsedResponse.apiError;
            } else if (!rawContent && !errorMsg) {
                const finishDetail = finishReason ? `，finish_reason=${finishReason}` : '';
                errorMsg = `API返回HTTP ${resp.status}，但未找到可解析的LLM正文${finishDetail}`;
            }
            if (rawContent) {
                const extracted = extractJsonObject(rawContent);
                if (extracted) {
                    result = extracted.value;
                }
            }
        }
    } catch (e) {
        if (e.name === 'AbortError') {
            aborted = true;
        } else {
            errorMsg = e.message;
        }
    } finally {
        if (timeout) clearTimeout(timeout);
        if (registerExternalAbort && llmAbortController === controller) {
            llmAbortController = null;
        }
        if (manageUi) activateSendButtons();
    }

    if (!showDebug) {
        if (aborted) {
            console.debug('[realmap] silent plugin LLM request aborted');
        } else if (errorMsg) {
            console.warn('[realmap] silent plugin LLM request failed:', errorMsg);
        } else if (rawContent && !result) {
            console.warn('[realmap] silent plugin LLM response was not valid JSON');
        }
    }

    let currentDebugReport = '';
    if (showDebug || typeof onDebugReport === 'function') {
        const parts = [
            `################ ${debugLabel} ################`,
            `=== 发送给LLM的消息 ===\n${JSON.stringify(messages, null, 2)}`,
        ];
        const responseMeta = [
            `状态：${httpStatus || '未收到'}${httpStatusText ? ` ${httpStatusText}` : ''}`,
            `请求输出上限：${maxTokens}tokens`,
            requestId ? `请求ID：${requestId}` : '',
            responseModel ? `响应模型：${responseModel}` : '',
            finishReason ? `finish_reason：${finishReason}` : '',
            contentSource ? `正文来源：${contentSource}` : '',
            usage ? `usage：${JSON.stringify(usage)}` : '',
        ].filter(Boolean);
        parts.push(`=== API 响应信息 ===\n${responseMeta.join('\n')}`);
        if (responseData !== null) {
            parts.push(`=== API 完整响应 ===\n${stringifyLlmResponse(responseData)}`);
        } else if (responseText) {
            parts.push(`=== API 原始响应正文 ===\n${responseText.slice(0, 20_000)}${responseText.length > 20_000 ? '\n…响应过长，已截断' : ''}`);
        }
        if (rawContent) {
            parts.push(`=== LLM原始输出${contentSource ? `（${contentSource}）` : ''} ===\n${rawContent}`);
        }
        if (result) {
            parts.push(`=== 解析结果 ===\n${JSON.stringify(result, null, 2)}`);
        } else if (errorMsg) {
            parts.push(`=== 错误 ===\n${errorMsg}`);
        } else if (rawContent) {
            parts.push(`=== 解析结果 ===\nJSON 解析失败`);
        } else if (aborted) {
            parts.push(`=== 状态 ===\n${timedOut ? '请求超时' : '请求已取消'}`);
        }
        currentDebugReport = parts.join('\n\n');
        if (typeof onDebugReport === 'function') {
            try {
                onDebugReport(currentDebugReport);
            } catch (error) {
                console.warn('[realmap] failed to capture plugin LLM debug report', error);
            }
        }
    }

    if (showDebug && !aborted) {
        const debugText = combineLlmDebugReports(prependDebugReports, currentDebugReport);
        const escapeHtml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const debugHtml = `<pre style="white-space:pre-wrap;font-size:12px;max-height:60vh;overflow-y:auto;color:var(--SmartThemeBodyColor);background:rgba(0,0,0,0.3);padding:12px;border-radius:4px">${escapeHtml(debugText)}</pre>`;
        const popup = new Popup(debugHtml, POPUP_TYPE.DISPLAY, '', { wide: true, large: true, okButton: '关闭', cancelButton: false });
        popup.show();
    }

    return result;
}

async function resolveLocation(llmResult, lastAiMessage, signal = null) {
    if (!llmResult || llmResult.action === 'null' || signal?.aborted) return null;
    const AMap = await waitForSignal(loadAmap(), signal, null);
    if (!AMap || signal?.aborted) return null;

    if (llmResult.action === 'idle' && llmResult.place) {
        return await resolveIdle(AMap, llmResult, lastAiMessage, signal);
    }
    if (llmResult.action === 'moving' && llmResult.from && llmResult.to) {
        return await resolveMoving(AMap, llmResult, lastAiMessage, signal);
    }
    return null;
}

async function resolveIdle(AMap, llmResult, lastAiMessage, signal = null) {
    const resolvedPlace = await resolvePlaceCandidate(
        AMap,
        llmResult.place,
        getCurrentPosition(),
        signal,
    );
    if (!resolvedPlace || signal?.aborted) return null;
    const { lng, lat } = resolvedPlace;

    const placeSearch = new AMap.PlaceSearch({ pageSize: 10, pageIndex: 1 });
    const nearby = await fetchNearbySummary(placeSearch, lng, lat, signal);
    const label = resolvedPlace.name || await reverseGeocode(AMap, lng, lat, signal);
    if (signal?.aborted) return null;

    const loc = {
        v: 2, captured_at: Date.now(),
        mode: 'idle', lng, lat, label,
        poi: llmResult.poi ?? false, nearby,
        ...(resolvedPlace.resolution ? { resolution: resolvedPlace.resolution } : {}),
    };
    writeLocationToMessage(lastAiMessage, loc);
    setChatState(loc);
    return loc;
}

async function resolveMoving(AMap, llmResult, lastAiMessage, signal = null) {
    const previousState = getChatState();
    const previousPosition = getCurrentPosition();
    const previousLocation = getLocationSnapshotFromState(previousState);
    const fromIntent = normalizePlaceIntent(llmResult.from);
    const reusePreviousOrigin = previousPosition
        && previousLocation
        && placeLabelsReferToSameLocation(fromIntent.full, previousLocation.label);
    const previousResolution = previousState?.mode === 'moving'
        ? previousState.from?.resolution
        : previousState?.resolution;
    const fromCoords = reusePreviousOrigin
        ? {
            lng: previousPosition.lng,
            lat: previousPosition.lat,
            name: previousLocation.label,
            ...(previousResolution ? { resolution: previousResolution } : {}),
        }
        : await resolvePlaceCandidate(
            AMap,
            llmResult.from,
            previousPosition,
            signal,
        );
    const toCoords = await resolvePlaceCandidate(
        AMap,
        llmResult.to,
        fromCoords || previousPosition,
        signal,
    );
    if (!fromCoords || !toCoords || signal?.aborted) return null;

    const routeMode = llmResult.route_mode || 'walking';
    const modeMap = {
        walking: 'AMap.Walking', driving: 'AMap.Driving',
        riding: 'AMap.Riding', transfer: 'AMap.Transfer',
    };
    const routeCls = AMap[modeMap[routeMode]?.split('.')[1]];
    if (!routeCls) return null;

    const opts = {};
    if (routeMode === 'transfer') {
        const cityRes = await reverseGeocodeComponent(
            AMap,
            fromCoords.lng,
            fromCoords.lat,
            signal,
        );
        if (signal?.aborted) return null;
        opts.city = cityRes?.city || cityRes?.province || '全国';
    }
    const router = new routeCls(opts);
    const routeResult = await runAmapCallbackWithSignal((finish) => {
        const origin = new AMap.LngLat(fromCoords.lng, fromCoords.lat);
        const dest = new AMap.LngLat(toCoords.lng, toCoords.lat);
        router.search(origin, dest, (status, result) => {
            finish(status === 'complete' ? result : null);
        });
    }, signal, null);
    if (!routeResult || signal?.aborted) return null;

    const route = routeMode === 'transfer' ? routeResult.plans?.[0] : routeResult.routes?.[0];
    if (!route) return null;

    const totalTime = route.time;
    const totalDist = route.distance;
    const polyline = extractRoutePolyline(route, routeMode);

    const routeDurationMin = Number(totalTime) / 60;
    const elapsedMin = getNarrativeElapsedMinutes(llmResult);
    const progressRatio = getMovingProgress(elapsedMin, routeDurationMin);
    const progressedPosition = progressRatio > 0
        ? getPointAlongRoute(polyline, progressRatio)
        : null;
    const currentRoutePosition = progressedPosition
        || projectPointToRoute(fromCoords, polyline)
        || fromCoords;
    const placeSearch = new AMap.PlaceSearch({ pageSize: 10, pageIndex: 1 });
    const nearby = await fetchNearbySummary(
        placeSearch,
        currentRoutePosition.lng,
        currentRoutePosition.lat,
        signal,
    );
    if (signal?.aborted) return null;

    const loc = {
        v: 2, captured_at: Date.now(),
        mode: 'moving',
        from: {
            lng: currentRoutePosition.lng,
            lat: currentRoutePosition.lat,
            label: fromCoords.name,
            ...(fromCoords.resolution ? { resolution: fromCoords.resolution } : {}),
        },
        to: {
            lng: toCoords.lng,
            lat: toCoords.lat,
            label: toCoords.name,
            ...(toCoords.resolution ? { resolution: toCoords.resolution } : {}),
        },
        route_mode: routeMode,
        duration_min: Math.round(routeDurationMin),
        elapsed_min: elapsedMin,
        progress_ratio: Math.round(progressRatio * 10_000) / 10_000,
        distance: totalDist,
        polyline,
        nearby,
    };
    writeLocationToMessage(lastAiMessage, loc);
    setChatState(loc);
    return loc;
}

function extractRoutePolyline(route, mode) {
    const pts = [];
    if (mode === 'transfer') {
        for (const seg of route.segments || []) {
            const path = seg.transit?.path;
            if (!path) continue;
            for (const p of path) {
                if (typeof p.getLng === 'function') pts.push([p.getLng(), p.getLat()]);
                else if (typeof p.lng === 'number') pts.push([p.lng, p.lat]);
            }
        }
    } else {
        for (const step of route.steps || []) {
            const path = step.path;
            if (!path) continue;
            if (typeof path === 'string') {
                path.split(';').forEach(p => {
                    const [lng, lat] = p.split(',');
                    if (lng && lat) pts.push([Number(lng), Number(lat)]);
                });
            } else if (Array.isArray(path)) {
                for (const p of path) {
                    if (typeof p.getLng === 'function') pts.push([p.getLng(), p.getLat()]);
                    else if (typeof p.lng === 'number') pts.push([p.lng, p.lat]);
                    else if (Array.isArray(p)) pts.push([Number(p[0]), Number(p[1])]);
                }
            }
        }
    }
    return pts;
}

async function resolvePlaceCandidate(AMap, query, origin = null, signal = null) {
    const intent = normalizePlaceIntent(query);
    if (!intent.full || signal?.aborted) return null;

    const narrativeResult = await resolveNarrativePlace(AMap, intent, { origin, signal });
    if (signal?.aborted) return null;
    if (narrativeResult) {
        const location = {
            lng: narrativeResult.lng,
            lat: narrativeResult.lat,
        };
        return {
            ...location,
            name: intent.full,
            address: narrativeResult.poi?.address || '',
            score: narrativeResult.confidence === 'high' ? 300 : narrativeResult.confidence === 'medium' ? 200 : 100,
            resolution: createResolutionMetadata(narrativeResult),
        };
    }

    if (!intent.hierarchical) {
        const ranked = await searchRankedPlaces(AMap, intent.full, {
            origin,
            city: intent.city || '全国',
            signal,
        });
        if (signal?.aborted) return null;
        const best = ranked[0];
        const location = getRankedPoiLocation(best);
        if (location && best.score >= MIN_INFERENCE_PLACE_SCORE) {
            return {
                ...location,
                name: intent.full,
                address: best.poi?.address || '',
                score: best.score,
                resolution: {
                    query: intent.full,
                    parent: intent.parent,
                    subplace: intent.subplace,
                    kind: intent.kind,
                    strategy: 'flat-ranked',
                    confidence: best.score >= 300 ? 'high' : 'medium',
                    poi_id: getPoiId(best.poi),
                    parent_poi_id: '',
                    resolved_name: String(best.poi?.name ?? ''),
                },
            };
        }
    }

    const geocoder = new AMap.Geocoder({ city: intent.city || '全国' });
    return runAmapCallbackWithSignal((finish) => {
        geocoder.getLocation(intent.full, (status, result) => {
            const geocode = status === 'complete' ? result?.geocodes?.[0] : null;
            const loc = geocode?.location;
            if (!loc || !isReliableGeocode(geocode, intent.city)) {
                finish(null);
                return;
            }
            const lng = typeof loc.getLng === 'function' ? loc.getLng() : Number(loc.lng);
            const lat = typeof loc.getLat === 'function' ? loc.getLat() : Number(loc.lat);
            finish(Number.isFinite(lng) && Number.isFinite(lat) ? {
                lng,
                lat,
                name: intent.full,
                address: geocode.formattedAddress || '',
                score: 0,
                resolution: {
                    query: intent.full,
                    parent: intent.parent,
                    subplace: intent.subplace,
                    kind: intent.kind,
                    strategy: 'geocode-fallback',
                    confidence: 'low',
                    poi_id: '',
                    parent_poi_id: '',
                    resolved_name: String(geocode.formattedAddress ?? ''),
                },
            } : null);
        });
    }, signal, null);
}

function createResolutionMetadata(result) {
    return {
        query: result.intent?.full || result.label || '',
        parent: result.intent?.parent || '',
        subplace: result.intent?.subplace || '',
        kind: result.intent?.kind || 'unknown',
        strategy: result.strategy || '',
        confidence: result.confidence || 'low',
        poi_id: getPoiId(result.poi),
        parent_poi_id: result.parentPoiId || getPoiId(result.parentPoi),
        resolved_name: String(result.poi?.name ?? ''),
    };
}

function getPoiId(poi) {
    const id = poi?.id ?? poi?.poiId ?? poi?.poiid;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : '';
}

function isReliableGeocode(geocode, city) {
    if (!geocode) return false;
    const level = String(geocode.level ?? '');
    if (/^(省|市|区县|乡镇)$/u.test(level)) return false;

    const normalizedCity = String(city ?? '').replace(/\s+/g, '');
    if (!normalizedCity) return true;
    const shortCity = normalizedCity.replace(/(特别行政区|自治州|地区|市)$/u, '');
    const administrativeText = [
        geocode.formattedAddress,
        geocode.province,
        geocode.city,
        geocode.district,
    ].filter(Boolean).join('').replace(/\s+/g, '');
    return administrativeText.includes(normalizedCity)
        || (shortCity.length >= 2 && administrativeText.includes(shortCity));
}

async function reverseGeocode(AMap, lng, lat, signal = null) {
    return runAmapCallbackWithSignal((finish) => {
        const geocoder = new AMap.Geocoder();
        geocoder.getAddress([lng, lat], (status, result) => {
            finish(status === 'complete' ? result?.regeocode?.formattedAddress : null);
        });
    }, signal, null);
}

async function reverseGeocodeComponent(AMap, lng, lat, signal = null) {
    return runAmapCallbackWithSignal((finish) => {
        const geocoder = new AMap.Geocoder();
        geocoder.getAddress([lng, lat], (status, result) => {
            finish(status === 'complete' ? result?.regeocode?.addressComponent : null);
        });
    }, signal, null);
}

async function fetchNearbySummary(placeSearch, lng, lat, signal = null) {
    return runAmapCallbackWithSignal((finish) => {
        placeSearch.searchNearBy('', [lng, lat], 500, (status, result) => {
            if (status !== 'complete' || !result?.poiList?.pois?.length) {
                finish('');
                return;
            }
            const pois = result.poiList.pois.slice(0, 5);
            const summary = pois.map(p => {
                const d = p.distance < 1000 ? `${Math.round(p.distance)}m` : `${(p.distance/1000).toFixed(1)}km`;
                const dir = getDirection(lng, lat, p.location);
                return `${p.name}(${dir}${d})`;
            }).join('、');
            finish(`周边：${summary}`);
        });
    }, signal, '');
}

function getDirection(centerLng, centerLat, loc) {
    if (!loc) return '';
    let poiLng, poiLat;
    if (typeof loc.getLng === 'function') { poiLng = loc.getLng(); poiLat = loc.getLat(); }
    else { poiLng = loc.lng; poiLat = loc.lat; }
    const dx = poiLng - centerLng;
    const dy = poiLat - centerLat;
    let angle = Math.atan2(dx, dy) * 180 / Math.PI;
    if (angle < 0) angle += 360;
    const dirs = ['北','东北','东','东南','南','西南','西','西北'];
    const idx = Math.round(angle / 45) % 8;
    return dirs[idx];
}

function writeLocationToMessage(lastAiMessage, loc) {
    if (!lastAiMessage?.message) return;
    if (!lastAiMessage.message.extra) lastAiMessage.message.extra = {};
    lastAiMessage.message.extra.realmap = loc;
    if (typeof lastAiMessage.message.swipe_id === 'number') {
        syncMesToSwipe(lastAiMessage.message, lastAiMessage.message.swipe_id);
    }
}

function copyPrevLocation() {
    const last = findLastAiMessage();
    if (!last) return null;
    const loc = last.message?.extra?.realmap;
    if (loc && (loc.lng !== undefined || (loc.mode === 'moving' && loc.from))) {
        setChatState(loc);
        return loc;
    }
    return null;
}

function updateExtensionPrompt() {
    if (!isExtensionEnabledForChat()) {
        clearPreflightInjection();
        setExtensionPrompt(REALMAP_INJECT_KEY, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }
    const last = findLastAiMessage();
    const loc = last?.message?.extra?.realmap;
    if (!loc || !loc.label) {
        if (loc?.mode === 'moving' && loc.from?.label) {
            const parts = [`[现实地图] 当前位置：${loc.from.label}`];
            if (loc.to?.label) parts.push(`目的地：${loc.to.label}`);
            if (loc.nearby) parts.push(loc.nearby);
            setExtensionPrompt(REALMAP_INJECT_KEY, parts.join('\n'), extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
            return;
        }
        setExtensionPrompt(REALMAP_INJECT_KEY, '', extension_prompt_types.IN_CHAT, 0);
        return;
    }
    const parts = [`[现实地图] 当前位置：${loc.label}`];
    if (loc.nearby) parts.push(loc.nearby);
    setExtensionPrompt(REALMAP_INJECT_KEY, parts.join('\n'), extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
}
