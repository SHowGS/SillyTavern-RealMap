import assert from 'node:assert/strict';
import test from 'node:test';

import {
    PLUGIN_LLM_LOG_STORAGE_KEY,
    readLatestPluginLlmLog,
    writeLatestPluginLlmLog,
} from './llm-log-cache.js';

function createStorage() {
    const values = new Map();
    return {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    };
}

test('stores the latest round reports in browser storage', () => {
    const storage = createStorage();
    writeLatestPluginLlmLog(
        storage,
        ['正文前信息补充LLM', '输出后位置推断LLM'],
        123,
    );

    assert.deepEqual(readLatestPluginLlmLog(storage), {
        v: 1,
        captured_at: 123,
        text: '正文前信息补充LLM\n\n输出后位置推断LLM',
    });
    assert.ok(storage.getItem(PLUGIN_LLM_LOG_STORAGE_KEY));
});

test('a newer round replaces the previous browser log', () => {
    const storage = createStorage();
    writeLatestPluginLlmLog(storage, ['旧日志'], 100);
    writeLatestPluginLlmLog(storage, ['新日志'], 200);

    assert.equal(readLatestPluginLlmLog(storage).text, '新日志');
    assert.equal(readLatestPluginLlmLog(storage).captured_at, 200);
});

test('ignores malformed browser log data', () => {
    const storage = createStorage();
    storage.setItem(PLUGIN_LLM_LOG_STORAGE_KEY, '{bad json');
    assert.equal(readLatestPluginLlmLog(storage), null);
});
