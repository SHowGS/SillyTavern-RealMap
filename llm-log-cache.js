import { combineLlmDebugReports } from './llm-response.js';

export const PLUGIN_LLM_LOG_STORAGE_KEY = 'realmap_latest_plugin_llm_log_v1';

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

export function readLatestPluginLlmLog(storage) {
    if (!storage?.getItem) return null;
    const raw = storage.getItem(PLUGIN_LLM_LOG_STORAGE_KEY);
    if (!raw) return null;
    try {
        const value = JSON.parse(raw);
        if (value?.v !== 1 || typeof value.text !== 'string' || !value.text.trim()) {
            return null;
        }
        return value;
    } catch (_) {
        return null;
    }
}
