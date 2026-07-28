import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PLUGIN_LLM_MAX_TOKENS,
    combineLlmDebugReports,
    extractJsonObject,
    parseLlmResponsePayload,
    stringifyLlmResponse,
} from './llm-response.js';

test('uses a 65536-token output limit for every plugin LLM call', () => {
    assert.equal(PLUGIN_LLM_MAX_TOKENS, 65536);
});

test('combines preflight and postflight debug reports in order', () => {
    assert.equal(
        combineLlmDebugReports('正文前信息补充LLM', '', '输出后位置推断LLM'),
        '正文前信息补充LLM\n\n输出后位置推断LLM',
    );
});

test('parses standard chat completion content', () => {
    const parsed = parseLlmResponsePayload({
        model: 'test-model',
        choices: [{
            finish_reason: 'stop',
            message: { content: '{"action":"none"}' },
        }],
        usage: { total_tokens: 20 },
    });
    assert.equal(parsed.rawContent, '{"action":"none"}');
    assert.equal(parsed.contentSource, 'choices[0].message.content');
    assert.equal(parsed.finishReason, 'stop');
    assert.equal(parsed.model, 'test-model');
    assert.deepEqual(parsed.usage, { total_tokens: 20 });
});

test('parses array-form message content', () => {
    const parsed = parseLlmResponsePayload({
        choices: [{
            message: {
                content: [
                    { type: 'text', text: '{"action":' },
                    { type: 'text', text: '"none"}' },
                ],
            },
        }],
    });
    assert.equal(parsed.rawContent, '{"action":\n"none"}');
    assert.equal(parsed.contentSource, 'choices[0].message.content');
});

test('supports text and output_text compatibility fields', () => {
    assert.equal(parseLlmResponsePayload({
        choices: [{ text: '{"action":"none"}' }],
    }).contentSource, 'choices[0].text');
    assert.equal(parseLlmResponsePayload({
        output_text: '{"action":"none"}',
    }).contentSource, 'output_text');
});

test('falls back to reasoning content when final content is empty', () => {
    const parsed = parseLlmResponsePayload({
        choices: [{
            finish_reason: 'length',
            message: {
                content: '',
                reasoning_content: '{"action":"none"}',
            },
        }],
    });
    assert.equal(parsed.rawContent, '{"action":"none"}');
    assert.equal(parsed.contentSource, 'choices[0].message.reasoning_content');
    assert.equal(parsed.finishReason, 'length');
});

test('extracts successful-status API error payloads', () => {
    const parsed = parseLlmResponsePayload({
        error: { message: 'quota exceeded' },
    });
    assert.equal(parsed.rawContent, '');
    assert.equal(parsed.apiError, 'quota exceeded');
});

test('bounds formatted raw responses', () => {
    const formatted = stringifyLlmResponse({ value: 'x'.repeat(100) }, 40);
    assert.match(formatted, /已截断$/u);
    assert.ok(formatted.length < 60);
});

test('extracts nested JSON from surrounding model text', () => {
    const extracted = extractJsonObject(`思考过程包含{无效文本}。
\`\`\`json
{"action":"idle","place":{"full":"成都{测试}","kind":"venue"}}
\`\`\`
以上是结果。`);
    assert.deepEqual(extracted.value, {
        action: 'idle',
        place: {
            full: '成都{测试}',
            kind: 'venue',
        },
    });
});

test('prefers the final action JSON when multiple objects are present', () => {
    const extracted = extractJsonObject(
        '{"example":true}\n说明\n{"action":"none"}\n{"debug":true}',
    );
    assert.deepEqual(extracted.value, { action: 'none' });
});
