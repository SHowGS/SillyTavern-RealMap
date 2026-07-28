import assert from 'node:assert/strict';
import test from 'node:test';

import {
    formatVersionLabel,
    getUpdateButtonPresentation,
} from './version-state.js';

test('version label contains only version and commit identity', () => {
    assert.equal(formatVersionLabel({
        manifestVersion: '1.0.1',
        branchName: 'main',
        commitHash: '1234567890',
    }), 'v1.0.1 · main-1234567');
});

test('up-to-date presentation is gray-state compatible and disabled', () => {
    assert.deepEqual(getUpdateButtonPresentation({
        hasUpdate: false,
        canUpdate: true,
    }), {
        available: false,
        current: true,
        disabled: true,
        text: '已是最新版',
        title: '当前已是最新版',
    });
});

test('available update remains actionable for an authorized user', () => {
    const state = getUpdateButtonPresentation({
        hasUpdate: true,
        canUpdate: true,
    });
    assert.equal(state.available, true);
    assert.equal(state.current, false);
    assert.equal(state.disabled, false);
    assert.equal(state.text, '更新');
});
