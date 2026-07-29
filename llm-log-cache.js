import { combineLlmDebugReports } from './llm-response.js';

export const PLUGIN_LLM_LOG_STORAGE_KEY = 'realmap_latest_plugin_llm_log_v1';
export const PLUGIN_LLM_LOG_STAGES = Object.freeze({
    PREFLIGHT: 'preflight',
    POSTFLIGHT: 'postflight',
});

export function formatMainLlmInjectionLog({
    key = '',
    position = '',
    depth = 0,
    role = '',
    scan = false,
    text = '',
} = {}) {
    const injectedText = String(text ?? '');
    return [
        '=== 主LLM注入信息 ===',
        `注入键：${String(key) || '未指定'}`,
        `注入位置：${String(position) || '未指定'}`,
        `注入深度：${Number.isFinite(Number(depth)) ? Number(depth) : '未指定'}`,
        `注入角色：${String(role) || '未指定'}`,
        `参与世界信息扫描：${scan ? '是' : '否'}`,
        `原文字符数：${injectedText.length}`,
        '',
        '=== 注入给主LLM的位置信息原文 ===',
        injectedText || '（空）',
    ].join('\n');
}

function hashText(value) {
    const text = String(value ?? '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `${text.length}:${(hash >>> 0).toString(16)}`;
}

export function getPluginLlmRoundKey(message) {
    if (!message || typeof message !== 'object') return '';
    const sendDate = String(message.send_date ?? '').trim();
    if (sendDate) return `sent:${sendDate}`;
    const generationId = String(message.gen_id ?? '').trim();
    if (generationId) return `generated:${generationId}`;
    return `message:${hashText(message.mes)}`;
}

export function createPluginLlmLog(reports, capturedAt = Date.now()) {
    const text = combineLlmDebugReports(reports);
    if (!text) return null;
    return {
        v: 1,
        captured_at: capturedAt,
        text,
    };
}

export function writeLatestPluginLlmLog(storage, reports, capturedAt = Date.now()) {
    const log = createPluginLlmLog(reports, capturedAt);
    if (!log || !storage?.setItem) return log;
    storage.setItem(PLUGIN_LLM_LOG_STORAGE_KEY, JSON.stringify(log));
    return log;
}

export function mergePluginLlmLogStage(previous, {
    roundKey,
    stage,
    report,
    capturedAt = Date.now(),
} = {}) {
    if (!roundKey
        || !Object.values(PLUGIN_LLM_LOG_STAGES).includes(stage)
        || !String(report ?? '').trim()) {
        return previous ?? null;
    }
    const sameRound = previous?.v === 2 && previous.round_key === roundKey;
    const reports = sameRound
        ? {
            preflight: String(previous.reports?.preflight ?? ''),
            postflight: String(previous.reports?.postflight ?? ''),
        }
        : { preflight: '', postflight: '' };
    if (stage === PLUGIN_LLM_LOG_STAGES.PREFLIGHT) {
        reports.postflight = '';
    }
    reports[stage] = String(report).trim();
    return {
        v: 2,
        captured_at: capturedAt,
        round_key: roundKey,
        reports,
        text: combineLlmDebugReports(reports.preflight, reports.postflight),
    };
}

export function writePluginLlmLogStage(
    storage,
    options,
    previous = readLatestPluginLlmLog(storage),
) {
    const log = mergePluginLlmLogStage(previous, options);
    if (!log || !storage?.setItem) return log;
    storage.setItem(PLUGIN_LLM_LOG_STORAGE_KEY, JSON.stringify(log));
    return log;
}

export function getPluginLlmLogStage(log, roundKey, stage) {
    if (log?.v !== 2
        || log.round_key !== roundKey
        || !Object.values(PLUGIN_LLM_LOG_STAGES).includes(stage)) {
        return '';
    }
    return String(log.reports?.[stage] ?? '').trim();
}

export function readLatestPluginLlmLog(storage) {
    if (!storage?.getItem) return null;
    const raw = storage.getItem(PLUGIN_LLM_LOG_STORAGE_KEY);
    if (!raw) return null;
    try {
        const value = JSON.parse(raw);
        if (![1, 2].includes(value?.v)
            || typeof value.text !== 'string'
            || !value.text.trim()) {
            return null;
        }
        if (value.v === 2
            && (typeof value.round_key !== 'string'
                || !value.round_key
                || typeof value.reports !== 'object'
                || value.reports === null)) {
            return null;
        }
        return value;
    } catch (_) {
        return null;
    }
}
