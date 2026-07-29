import assert from 'node:assert/strict';
import test from 'node:test';

import {
    PLUGIN_LLM_LOG_STORAGE_KEY,
    PLUGIN_LLM_LOG_STAGES,
    formatMainLlmInjectionLog,
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

test('formats the exact main LLM injection text and placement metadata', () => {
    const text = '[现实地图·本轮移动参考]\n起点：医院\n目的地：车站';
    const report = formatMainLlmInjectionLog({
        key: 'realmapPreflightContext',
        position: 'IN_CHAT（聊天上下文）',
        depth: 0,
        role: 'SYSTEM',
        scan: false,
        text,
    });

    assert.match(report, /注入键：realmapPreflightContext/u);
    assert.match(report, /注入位置：IN_CHAT（聊天上下文）/u);
    assert.match(report, /注入深度：0/u);
    assert.match(report, /注入角色：SYSTEM/u);
    assert.match(report, /参与世界信息扫描：否/u);
    assert.match(report, new RegExp(`原文字符数：${text.length}`, 'u'));
    assert.ok(report.endsWith(text));
});

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

test('round key stays stable when prompt regex changes message text', () => {
    const original = {
        send_date: '2026-07-28T15:00:00.123Z',
        mes: '前往龙潭院区',
    };
    const regexed = {
        ...original,
        mes: '前往成都市第二人民医院龙潭院区',
    };

    assert.equal(
        getPluginLlmRoundKey(regexed),
        getPluginLlmRoundKey(original),
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
