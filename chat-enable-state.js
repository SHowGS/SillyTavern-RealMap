export const CHAT_ENABLE_META_KEY = 'realmap_enabled';

export function getStoredChatEnableState(metadata) {
    if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, CHAT_ENABLE_META_KEY)) {
        return null;
    }
    return Boolean(metadata[CHAT_ENABLE_META_KEY]);
}
