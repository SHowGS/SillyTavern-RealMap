export const CHAT_ENABLE_META_KEY = 'realmap_enabled';

export function getStoredChatEnableState(metadata) {
    if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, CHAT_ENABLE_META_KEY)) {
        return null;
    }
    return metadata[CHAT_ENABLE_META_KEY] === true;
}

export function isChatRuntimeEnabled(enabledState) {
    return enabledState === true;
}

export function isChatRunActive({
    enabledState,
    expectedChat,
    currentChat,
    expectedRunId,
    currentRunId,
    aborted = false,
} = {}) {
    if (!isChatRuntimeEnabled(enabledState) || aborted) return false;
    if (expectedChat !== currentChat) return false;
    if (expectedRunId !== undefined && expectedRunId !== currentRunId) return false;
    return true;
}
