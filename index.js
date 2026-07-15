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
 * @property {string} llmPromptSystem 系统提示词
 * @property {string} llmPromptSuffix 追加约束
 * @property {string} llmPromptJsonSchema 输出 JSON 格式说明
 * @property {string} llmPromptToolSpec 工具说明（预留）
 * @property {string} llmPromptFallback null 时用户话术模板
 */

const DEFAULT_PROMPTS = {
    system: '你是位置推断助手。你会读到一段角色扮演对话：包含上一轮用户/AI 正文、上一轮确定的位置（如有），以及本轮用户/AI 正文。你的任务是判断本轮结束时用户角色所处的地点，并以 JSON 输出。\n\n规则：\n- 仅依据正文描述判断，不脑补。\n- 上一轮位置仅作参考，不直接沿用，除非本轮正文明确表示原地未动。\n- 输出地点用中文具体名（如「望京 SOHO」「故宫太和殿」），避免行政泛指。\n- 无法确定时输出 {"action":"null","reason":"..."}。',
    suffix: '一律使用中文地点名。不要解释。只输出 JSON。',
    json_schema: '{ "action":"idle", "place":"望京SOHO", "poi":true }\n{ "action":"moving", "from":"...","to":"...","route_mode":"walking","duration_min":30 }\n{ "action":"null", "reason":"叙事未含足够地理信息" }',
    tool_spec: '（保留字段，暂未启用工具调用模式）',
    fallback: '本轮位置推断失败：{reason}。可在地图上手动确认或调用 /realmap.set 纠正。',
};

const DEFAULT_SETTINGS = {
    key: '',
    securityCode: '',
    llmSource: 'openai',
    llmCustomUrl: '',
    llmApiKey: '',
    llmModel: '',
    llmPromptSystem: DEFAULT_PROMPTS.system,
    llmPromptSuffix: DEFAULT_PROMPTS.suffix,
    llmPromptJsonSchema: DEFAULT_PROMPTS.json_schema,
    llmPromptToolSpec: DEFAULT_PROMPTS.tool_spec,
    llmPromptFallback: DEFAULT_PROMPTS.fallback,
};

function ensureSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    // 仅对缺失字段（undefined）填默认；已存在的空字符串视为用户主动清空，保留。
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (extension_settings[MODULE_NAME][k] === undefined) {
            extension_settings[MODULE_NAME][k] = DEFAULT_SETTINGS[k];
        }
    }
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

    // 提示词五段绑定
    const promptFields = [
        ['#realmap_prompt_system', 'llmPromptSystem'],
        ['#realmap_prompt_suffix', 'llmPromptSuffix'],
        ['#realmap_prompt_json_schema', 'llmPromptJsonSchema'],
        ['#realmap_prompt_tool_spec', 'llmPromptToolSpec'],
        ['#realmap_prompt_fallback', 'llmPromptFallback'],
    ];
    for (const [sel, key] of promptFields) {
        $(sel).val(s[key] ?? '').on('input', function () {
            s[key] = String($(this).val());
            saveSettingsDebounced();
        });
    }

    // 恢复默认按钮
    $('#realmap_prompt_reset').on('click', () => {
        s.llmPromptSystem = DEFAULT_PROMPTS.system;
        s.llmPromptSuffix = DEFAULT_PROMPTS.suffix;
        s.llmPromptJsonSchema = DEFAULT_PROMPTS.json_schema;
        s.llmPromptToolSpec = DEFAULT_PROMPTS.tool_spec;
        s.llmPromptFallback = DEFAULT_PROMPTS.fallback;
        $('#realmap_prompt_system').val(DEFAULT_PROMPTS.system);
        $('#realmap_prompt_suffix').val(DEFAULT_PROMPTS.suffix);
        $('#realmap_prompt_json_schema').val(DEFAULT_PROMPTS.json_schema);
        $('#realmap_prompt_tool_spec').val(DEFAULT_PROMPTS.tool_spec);
        $('#realmap_prompt_fallback').val(DEFAULT_PROMPTS.fallback);
        saveSettingsDebounced();
        toastr.success(t`已恢复默认提示词。`);
    });

    // Tab 切换：每次重载默认显示 api
    $('.realmap_tab').on('click', function () {
        const tab = $(this).data('tab');
        $('.realmap_tab').removeClass('active');
        $(this).addClass('active');
        $('.realmap_tab_panel').hide();
        $(`.realmap_tab_panel[data-panel="${tab}"]`).show();
    });
    $('.realmap_tab[data-tab="api"]').trigger('click');
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
