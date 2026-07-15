import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { t } from '../../../i18n.js';

const MODULE_NAME = 'realmap';
const LOADER_URL = 'https://webapi.amap.com/loader.js';

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
    extension_settings[MODULE_NAME] = Object.assign({}, DEFAULT_SETTINGS, extension_settings[MODULE_NAME]);
    return extension_settings[MODULE_NAME];
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
    console.debug('[realmap] initialized');
}
