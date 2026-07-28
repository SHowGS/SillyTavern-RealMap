import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_SYSTEM_PROMPT,
    formatPluginLocation,
    renderContextPrompt,
    renderPreflightPrompt,
} from './prompts.js';

test('formatPluginLocation includes precise coordinates for plugin LLM context', () => {
    assert.equal(
        formatPluginLocation({
            label: '成都市第二人民医院龙潭院区',
            lng: 104.15432149,
            lat: 30.71234549,
        }),
        '成都市第二人民医院龙潭院区（GCJ-02：经度104.154321，纬度30.712345）',
    );
});

test('plugin LLM prompt renderers retain the private coordinate context', () => {
    const location = formatPluginLocation({
        label: '成都东站',
        lng: 104.141,
        lat: 30.629,
    });

    assert.match(renderPreflightPrompt({ currentLocation: location }), /104\.141000/);
    assert.match(renderContextPrompt({ previousLocation: location }), /30\.629000/);
});

test('formatPluginLocation does not invent zero coordinates for missing data', () => {
    assert.equal(formatPluginLocation({ label: '成都东站', lng: null, lat: null }), '成都东站');
});

test('location inference prompt requires narrative elapsed time for moving state', () => {
    assert.match(DEFAULT_SYSTEM_PROMPT, /moving时必须.*elapsed_min/u);
    assert.match(DEFAULT_SYSTEM_PROMPT, /不得填写地图预计耗时/u);
    assert.match(DEFAULT_SYSTEM_PROMPT, /"elapsed_min":12/u);
});
