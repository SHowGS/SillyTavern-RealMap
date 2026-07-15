import { extension_settings, getContext } from '../../../extensions.js';
import { chat_metadata, saveMetadataDebounced, saveMetadata } from '../../../../script.js';

export { extension_settings, chat_metadata };

export const MODULE_NAME = 'realmap';
const META_ENABLED = 'realmap_enabled';
const META_STATE = 'realmap_state';
const LOC_KEYS = {
    x: 'realmap_window_x',
    y: 'realmap_window_y',
    w: 'realmap_window_w',
    h: 'realmap_window_h',
};

const DEFAULT_SETTINGS = {
    key: '',
    securityCode: '',
    llmSource: 'openai',
    llmCustomUrl: '',
    llmApiKey: '',
    llmModel: '',
};

export function ensureBaseSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (extension_settings[MODULE_NAME][k] === undefined) {
            extension_settings[MODULE_NAME][k] = DEFAULT_SETTINGS[k];
        }
    }
    return extension_settings[MODULE_NAME];
}

export function isExtensionEnabledForChat() {
    return Boolean(chat_metadata[META_ENABLED]);
}

export function setExtensionEnabledForChat(on, { immediate = false } = {}) {
    chat_metadata[META_ENABLED] = Boolean(on);
    if (immediate) {
        saveMetadata();
    } else {
        saveMetadataDebounced();
    }
}

export function getChatState() {
    return chat_metadata[META_STATE] ?? null;
}

export function setChatState(state, { immediate = false } = {}) {
    if (state === null) {
        delete chat_metadata[META_STATE];
    } else {
        chat_metadata[META_STATE] = state;
    }
    if (immediate) {
        saveMetadata();
    } else {
        saveMetadataDebounced();
    }
}

export function clearAllChatLocations() {
    const ctx = getContext();
    const chat = ctx?.chat;
    if (Array.isArray(chat)) {
        for (const m of chat) {
            if (m?.extra?.realmap) {
                delete m.extra.realmap;
            }
        }
    }
    delete chat_metadata[META_STATE];
    saveMetadata();
}

export function findLastAiMessage() {
    const ctx = getContext();
    const chat = ctx?.chat;
    if (!Array.isArray(chat) || chat.length === 0) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m || m.is_user || m.is_system) continue;
        if (Array.isArray(m.swipes) && typeof m.swipe_id === 'number' && m.swipe_id >= m.swipes.length) continue;
        return { index: i, message: m };
    }
    return null;
}

export function getVisibleMessages() {
    const ctx = getContext();
    const chat = ctx?.chat;
    if (!Array.isArray(chat)) return [];
    return chat.filter(m => !m?.is_system && typeof m?.mes === 'string');
}

export function saveWindowPos(x, y, w, h) {
    const ctx = getContext();
    const as = ctx?.accountStorage;
    if (!as) return;
    as.setItem(LOC_KEYS.x, String(Math.round(x)));
    as.setItem(LOC_KEYS.y, String(Math.round(y)));
    as.setItem(LOC_KEYS.w, String(Math.round(w)));
    as.setItem(LOC_KEYS.h, String(Math.round(h)));
}

export function loadWindowPos() {
    const ctx = getContext();
    const as = ctx?.accountStorage;
    if (!as) return null;
    const x = as.getItem(LOC_KEYS.x);
    const y = as.getItem(LOC_KEYS.y);
    const w = as.getItem(LOC_KEYS.w);
    const h = as.getItem(LOC_KEYS.h);
    if (x === null || y === null) return null;
    const num = v => (v === null ? null : Number(v));
    return {
        x: num(x), y: num(y),
        w: num(w) ?? 320, h: num(h) ?? 180,
    };
}

export function syncMesToSwipe(message, swipeId) {
    if (!message || !Array.isArray(message.swipe_info) || typeof swipeId !== 'number') return;
    const si = message.swipe_info[swipeId];
    if (!si) return;
    si.send_date = message.send_date;
    si.gen_started = message.gen_started;
    si.gen_finished = message.gen_finished;
    si.extra = structuredClone(message.extra ?? {});
}
