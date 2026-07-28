import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CHAT_ENABLE_META_KEY,
    getStoredChatEnableState,
    isChatRunActive,
    isChatRuntimeEnabled,
} from './chat-enable-state.js';

test('distinguishes undecided, enabled, and explicitly disabled chats', () => {
    assert.equal(getStoredChatEnableState({}), null);
    assert.equal(getStoredChatEnableState({ [CHAT_ENABLE_META_KEY]: true }), true);
    assert.equal(getStoredChatEnableState({ [CHAT_ENABLE_META_KEY]: false }), false);
    assert.equal(getStoredChatEnableState({ [CHAT_ENABLE_META_KEY]: 'false' }), false);
    assert.equal(getStoredChatEnableState({ [CHAT_ENABLE_META_KEY]: 'true' }), false);
});

test('requires an explicitly enabled chat before any runtime work', () => {
    assert.equal(isChatRuntimeEnabled(null), false);
    assert.equal(isChatRuntimeEnabled(false), false);
    assert.equal(isChatRuntimeEnabled(true), true);
});

test('rejects disabled, switched, superseded, and aborted chat runs', () => {
    const chat = [];
    const base = {
        enabledState: true,
        expectedChat: chat,
        currentChat: chat,
        expectedRunId: 3,
        currentRunId: 3,
    };

    assert.equal(isChatRunActive(base), true);
    assert.equal(isChatRunActive({ ...base, enabledState: false }), false);
    assert.equal(isChatRunActive({ ...base, currentChat: [] }), false);
    assert.equal(isChatRunActive({ ...base, currentRunId: 4 }), false);
    assert.equal(isChatRunActive({ ...base, aborted: true }), false);
});
