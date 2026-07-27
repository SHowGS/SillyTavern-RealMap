import { extension_settings, renderExtensionTemplateAsync, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types, chat_metadata, setExtensionPrompt, extension_prompt_types, extension_prompt_roles, setExternalAbortController, deactivateSendButtons, activateSendButtons } from '../../../../script.js';
import { t } from '../../../i18n.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { resetAmapCache } from './amap.js';
import { setExtensionEnabledForChat, isExtensionEnabledForChat, findLastAiMessage, getVisibleMessages, clearAllChatLocations, setChatState, getChatState, syncMesToSwipe, getCurrentPosition } from './state.js';
import { initMinimap, showMinimap, hideMinimap, refreshMap } from './minimap.js';
import { DEFAULT_SYSTEM_PROMPT, DEFAULT_ASSISTANT_REPLY, DEFAULT_ASSISTANT_PREFILL, renderContextPrompt } from './prompts.js';
import { searchRankedPlaces, getRankedPoiLocation } from './place-search.js';

const MODULE_NAME = 'realmap';
const LOADER_URL = 'https://webapi.amap.com/loader.js';
const REALMAP_INJECT_KEY = 'realmapLocationContext';
const MIN_INFERENCE_PLACE_SCORE = 80;

let chatChangedTimer = null;
let chatChangedRunning = false;
let llmAbortController = null;

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
    toggleLlmCustomUrl();

}

function toggleLlmCustomUrl() {
    $('#realmap_llm_custom_url_block').toggle($('#realmap_llm_source').val() === 'custom');
}

export async function init() {
    const settingsHtml = await renderExtensionTemplateAsync('third-party/SillyTavern-RealMap', 'settings');
    $('#extensions_settings').append(settingsHtml);
    bindSettings();
    injectMinimapHtml();
    await initMinimap({ onDisableClick: handleDisableClick, onRejudge: handleRejudge });
    eventSource.on(event_types.CHAT_CHANGED, debouncedOnChatChanged);
    eventSource.on(event_types.MESSAGE_DELETED, debouncedOnChatChanged);
    eventSource.on(event_types.MESSAGE_EDITED, debouncedOnChatChanged);
    eventSource.makeLast(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => void onAiMessage(messageId));
    onChatChanged();
    $('#realmap_enable_btn').on('click', () => void handleEnableFromSettings());
    console.debug('[realmap] initialized');
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
    const enabled = isExtensionEnabledForChat();
    if (enabled) {
        // 刷新后 chat_metadata 可能过期/为空，从最后一条 AI 消息同步位置
        const last = findLastAiMessage();
        if (last?.message?.extra?.realmap) {
            setChatState(last.message.extra.realmap);
        }
        await refreshMap();
        showMinimap();
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
            setExtensionEnabledForChat(false);
            hideMinimap();
            return;
        }
        setExtensionEnabledForChat(true);
        await inferLocationFromVisible();
        await refreshMap();
        showMinimap();
    } else {
        const ok = await askEnable('是否启用现实地图？');
        if (!ok) {
            setExtensionEnabledForChat(false);
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
    await refreshMap();
    updateExtensionPrompt();
}

async function handleRejudge() {
    if (!isChatOpen() || !isExtensionEnabledForChat()) return;
    await inferLocationFromVisible();
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
    setExtensionEnabledForChat(true);
    const last = findLastAiMessage();
    if (last) {
        await inferLocationFromVisible();
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

    const messages = buildLlmMessages(chat);
    const llmResult = await callPluginLlm(s, messages);
    if (!llmResult) {
        return copyPrevLocation();
    }

    const loc = await resolveLocation(llmResult, last);
    return loc;
}

function buildLlmMessages(chat) {
    const visible = chat.filter(m => !m?.is_system && typeof m?.mes === 'string');
    const lastIdx = visible.length - 1;
    const prevAiMes = visible.slice(0, lastIdx).reverse().find(m => !m.is_user);
    const curAiMes = visible[lastIdx];
    const curUserMes = visible.slice(0, lastIdx).reverse().find(m => m.is_user);

    const prevLoc = prevAiMes?.extra?.realmap;
    const previousLocation = prevLoc?.label || prevLoc?.from?.label || '无';
    const contextPrompt = renderContextPrompt({
        previousLocation,
        previousAi: prevAiMes?.mes || '无',
        currentUser: curUserMes?.mes || '无',
        currentAi: curAiMes?.mes || '无',
    });

    const messages = [
        { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
        { role: 'assistant', content: DEFAULT_ASSISTANT_REPLY },
        { role: 'user', content: contextPrompt },
        { role: 'assistant', content: DEFAULT_ASSISTANT_PREFILL },
    ];
    return messages;
}

async function callPluginLlm(s, messages) {
    const baseUrl = getLlmBaseUrl(s);
    if (!baseUrl) return null;

    llmAbortController = new AbortController();
    setExternalAbortController(llmAbortController);
    deactivateSendButtons();

    let result = null;
    let rawContent = '';
    let aborted = false;
    let errorMsg = '';

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
                max_tokens: 300,
            }),
            signal: llmAbortController.signal,
        });
        if (!resp.ok) {
            errorMsg = `HTTP ${resp.status}`;
        } else {
            const data = await resp.json();
            rawContent = data?.choices?.[0]?.message?.content || '';
            const trailingAssistant = messages.at(-1)?.role === 'assistant'
                ? String(messages.at(-1)?.content || '')
                : '';
            const parseCandidates = [rawContent];
            if (trailingAssistant && !rawContent.trimStart().startsWith(trailingAssistant)) {
                parseCandidates.push(`${trailingAssistant}${rawContent}`);
            }
            for (const candidate of parseCandidates) {
                const jsonMatch = candidate.match(/\{[\s\S]*\}/);
                if (!jsonMatch) continue;
                try {
                    result = JSON.parse(jsonMatch[0]);
                    break;
                } catch (_) {
                    // 尝试下一个包含预填充内容的候选文本。
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
        llmAbortController = null;
        activateSendButtons();
    }

    if (!aborted) {
        const parts = [`=== 发送给 LLM 的消息 ===\n${JSON.stringify(messages, null, 2)}`];
        if (rawContent) {
            parts.push(`=== LLM 原始输出 ===\n${rawContent}`);
        }
        if (result) {
            parts.push(`=== 解析结果 ===\n${JSON.stringify(result, null, 2)}`);
        } else if (errorMsg) {
            parts.push(`=== 错误 ===\n${errorMsg}`);
        } else if (rawContent) {
            parts.push(`=== 解析结果 ===\nJSON 解析失败`);
        }
        const debugText = parts.join('\n\n');
        const escapeHtml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const debugHtml = `<pre style="white-space:pre-wrap;font-size:12px;max-height:60vh;overflow-y:auto;color:var(--SmartThemeBodyColor);background:rgba(0,0,0,0.3);padding:12px;border-radius:4px">${escapeHtml(debugText)}</pre>`;
        const popup = new Popup(debugHtml, POPUP_TYPE.DISPLAY, '', { wide: true, large: true, okButton: '关闭', cancelButton: false });
        popup.show();
    }

    return result;
}

async function resolveLocation(llmResult, lastAiMessage) {
    if (!llmResult || llmResult.action === 'null') return null;
    const AMap = await loadAmap();

    if (llmResult.action === 'idle' && llmResult.place) {
        return await resolveIdle(AMap, llmResult, lastAiMessage);
    }
    if (llmResult.action === 'moving' && llmResult.from && llmResult.to) {
        return await resolveMoving(AMap, llmResult, lastAiMessage);
    }
    return null;
}

async function resolveIdle(AMap, llmResult, lastAiMessage) {
    const resolvedPlace = await resolvePlaceCandidate(AMap, llmResult.place, getCurrentPosition());
    if (!resolvedPlace) return null;
    const { lng, lat } = resolvedPlace;

    const placeSearch = new AMap.PlaceSearch({ pageSize: 10, pageIndex: 1 });
    const nearby = await fetchNearbySummary(placeSearch, lng, lat);
    const label = resolvedPlace.name || await reverseGeocode(AMap, lng, lat) || llmResult.place;

    const loc = {
        v: 2, captured_at: Date.now(),
        mode: 'idle', lng, lat, label,
        poi: llmResult.poi ?? false, nearby,
    };
    writeLocationToMessage(lastAiMessage, loc);
    setChatState(loc);
    return loc;
}

async function resolveMoving(AMap, llmResult, lastAiMessage) {
    const previousPosition = getCurrentPosition();
    const fromCoords = await resolvePlaceCandidate(AMap, llmResult.from, previousPosition);
    const toCoords = await resolvePlaceCandidate(AMap, llmResult.to, fromCoords || previousPosition);
    if (!fromCoords || !toCoords) return null;

    const routeMode = llmResult.route_mode || 'walking';
    const modeMap = {
        walking: 'AMap.Walking', driving: 'AMap.Driving',
        riding: 'AMap.Riding', transfer: 'AMap.Transfer',
    };
    const routeCls = AMap[modeMap[routeMode]?.split('.')[1]];
    if (!routeCls) return null;

    const opts = {};
    if (routeMode === 'transfer') {
        const cityRes = await reverseGeocodeComponent(AMap, fromCoords.lng, fromCoords.lat);
        opts.city = cityRes?.city || cityRes?.province || '全国';
    }
    const router = new routeCls(opts);
    const routeResult = await new Promise((resolve) => {
        const origin = new AMap.LngLat(fromCoords.lng, fromCoords.lat);
        const dest = new AMap.LngLat(toCoords.lng, toCoords.lat);
        router.search(origin, dest, (status, result) => {
            resolve(status === 'complete' ? result : null);
        });
    });
    if (!routeResult) return null;

    const route = routeMode === 'transfer' ? routeResult.plans?.[0] : routeResult.routes?.[0];
    if (!route) return null;

    const totalTime = route.time;
    const totalDist = route.distance;
    const polyline = extractRoutePolyline(route, routeMode);

    const placeSearch = new AMap.PlaceSearch({ pageSize: 10, pageIndex: 1 });
    const nearby = await fetchNearbySummary(placeSearch, fromCoords.lng, fromCoords.lat);

    const loc = {
        v: 2, captured_at: Date.now(),
        mode: 'moving',
        from: { lng: fromCoords.lng, lat: fromCoords.lat, label: fromCoords.name || llmResult.from },
        to: { lng: toCoords.lng, lat: toCoords.lat, label: toCoords.name || llmResult.to },
        route_mode: routeMode,
        duration_min: Math.round(totalTime / 60),
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

async function resolvePlaceCandidate(AMap, query, origin = null) {
    const ranked = await searchRankedPlaces(AMap, query, { origin });
    const best = ranked[0];
    const location = getRankedPoiLocation(best);
    if (location && best.score >= MIN_INFERENCE_PLACE_SCORE) {
        return {
            ...location,
            name: best.poi?.name || String(query),
            address: best.poi?.address || '',
            score: best.score,
        };
    }

    const geocoder = new AMap.Geocoder({ city: '全国' });
    return new Promise((resolve) => {
        geocoder.getLocation(query, (status, result) => {
            const geocode = status === 'complete' ? result?.geocodes?.[0] : null;
            const loc = geocode?.location;
            resolve(loc ? {
                lng: loc.getLng(),
                lat: loc.getLat(),
                name: geocode.formattedAddress || String(query),
                address: geocode.formattedAddress || '',
                score: 0,
            } : null);
        });
    });
}

async function reverseGeocode(AMap, lng, lat) {
    return new Promise((resolve) => {
        const geocoder = new AMap.Geocoder();
        geocoder.getAddress([lng, lat], (status, result) => {
            resolve(status === 'complete' ? result?.regeocode?.formattedAddress : null);
        });
    });
}

async function reverseGeocodeComponent(AMap, lng, lat) {
    return new Promise((resolve) => {
        const geocoder = new AMap.Geocoder();
        geocoder.getAddress([lng, lat], (status, result) => {
            resolve(status === 'complete' ? result?.regeocode?.addressComponent : null);
        });
    });
}

async function fetchNearbySummary(placeSearch, lng, lat) {
    return new Promise((resolve) => {
        placeSearch.searchNearBy('', [lng, lat], 500, (status, result) => {
            if (status !== 'complete' || !result?.poiList?.pois?.length) {
                resolve('');
                return;
            }
            const pois = result.poiList.pois.slice(0, 5);
            const summary = pois.map(p => {
                const d = p.distance < 1000 ? `${Math.round(p.distance)}m` : `${(p.distance/1000).toFixed(1)}km`;
                const dir = getDirection(lng, lat, p.location);
                return `${p.name}(${dir}${d})`;
            }).join('、');
            resolve(`周边：${summary}`);
        });
    });
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
