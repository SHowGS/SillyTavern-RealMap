import assert from 'node:assert/strict';
import test from 'node:test';

import {
    CHAT_ENABLE_META_KEY,
    getStoredChatEnableState,
} from './chat-enable-state.js';

test('distinguishes undecided, enabled, and explicitly disabled chats', () => {
    assert.equal(getStoredChatEnableState({}), null);
    assert.equal(getStoredChatEnableState({ [CHAT_ENABLE_META_KEY]: true }), true);
    assert.equal(getStoredChatEnableState({ [CHAT_ENABLE_META_KEY]: false }), false);
});
