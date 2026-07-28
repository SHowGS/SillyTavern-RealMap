import assert from 'node:assert/strict';
import test from 'node:test';

import {
    PLUGIN_LLM_LOG_STORAGE_KEY,
    PLUGIN_LLM_LOG_STAGES,
    getPluginLlmLogStage,
    getPluginLlmRoundKey,
    mergePluginLlmLogStage,
    readLatestPluginLlmLog,
    writeLatestPluginLlmLog,
    writePluginLlmLogStage,
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

test('merges both plugin calls by a stable user-message round key', () => {
    const storage = createStorage();
    const message = {
        send_date: 123,
        mes: '前往龙潭院区',
    };
    const clonedMessage = structuredClone(message);
    const roundKey = getPluginLlmRoundKey(message);
    assert.equal(getPluginLlmRoundKey(clonedMessage), roundKey);

    writePluginLlmLogStage(storage, {
        roundKey,
        stage: PLUGIN_LLM_LOG_STAGES.PREFLIGHT,
        report: '第一次调用',
        capturedAt: 100,
    });
    writePluginLlmLogStage(storage, {
        roundKey: getPluginLlmRoundKey(clonedMessage),
        stage: PLUGIN_LLM_LOG_STAGES.POSTFLIGHT,
        report: '第二次调用',
        capturedAt: 200,
    });

    const log = readLatestPluginLlmLog(storage);
    assert.equal(log.v, 2);
    assert.equal(log.text, '第一次调用\n\n第二次调用');
    assert.equal(
        getPluginLlmLogStage(log, roundKey, PLUGIN_LLM_LOG_STAGES.PREFLIGHT),
        '第一次调用',
    );
});

test('a new user-message round cannot inherit the previous preflight report', () => {
    const first = mergePluginLlmLogStage(null, {
        roundKey: 'round-1',
        stage: PLUGIN_LLM_LOG_STAGES.PREFLIGHT,
        report: '旧第一次调用',
        capturedAt: 100,
    });
    const second = mergePluginLlmLogStage(first, {
        roundKey: 'round-2',
        stage: PLUGIN_LLM_LOG_STAGES.POSTFLIGHT,
        report: '新第二次调用',
        capturedAt: 200,
    });

    assert.equal(second.text, '新第二次调用');
    assert.equal(second.reports.preflight, '');
});

test('a fresh preflight attempt clears the previous response report', () => {
    const completed = mergePluginLlmLogStage(
        mergePluginLlmLogStage(null, {
            roundKey: 'same-message',
            stage: PLUGIN_LLM_LOG_STAGES.PREFLIGHT,
            report: '旧第一次调用',
            capturedAt: 100,
        }),
        {
            roundKey: 'same-message',
            stage: PLUGIN_LLM_LOG_STAGES.POSTFLIGHT,
            report: '旧第二次调用',
            capturedAt: 200,
        },
    );
    const restarted = mergePluginLlmLogStage(completed, {
        roundKey: 'same-message',
        stage: PLUGIN_LLM_LOG_STAGES.PREFLIGHT,
        report: '新第一次调用',
        capturedAt: 300,
    });

    assert.equal(restarted.text, '新第一次调用');
    assert.equal(restarted.reports.postflight, '');
});
