import test from 'node:test';
import assert from 'node:assert/strict';

import { GenerationCancellationScope } from './generation-cancel.js';

test('installs the cancellation scope before the main controller is ready', () => {
    const scope = new GenerationCancellationScope();
    assert.equal(scope.shouldInstallAsExternalController(), true);

    scope.markMainControllerReady();
    assert.equal(scope.shouldInstallAsExternalController(), false);
});

test('stopping a generation aborts current and future child work', () => {
    const scope = new GenerationCancellationScope();
    const current = scope.createChildController();

    scope.requestStop('stop');

    assert.equal(scope.stopRequested, true);
    assert.equal(scope.signal.aborted, true);
    assert.equal(current.signal.aborted, true);
    assert.equal(scope.createChildController().signal.aborted, true);
});

test('finishing one child operation does not cancel the generation', () => {
    const scope = new GenerationCancellationScope();
    const child = scope.createChildController();

    child.abort('operation finished');

    assert.equal(scope.signal.aborted, false);
    assert.equal(scope.stopRequested, false);
});

test('an existing main signal is linked to plugin and map work', () => {
    const main = new AbortController();
    const scope = new GenerationCancellationScope(main.signal);
    const child = scope.createChildController();

    assert.equal(scope.shouldInstallAsExternalController(), false);
    main.abort('main stopped');

    assert.equal(scope.stopRequested, true);
    assert.equal(child.signal.aborted, true);
});
