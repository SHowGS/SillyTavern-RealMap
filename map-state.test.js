import assert from 'node:assert/strict';
import test from 'node:test';

import {
    addAmapRoutePolyline,
    createAmapDestinationMarker,
    getMovingProgress,
    getMovingRoutePosition,
    getPointAlongRoute,
    placeLabelsReferToSameLocation,
    projectPointToRoute,
    splitRouteAtProgress,
} from './map-state.js';

test('projectPointToRoute projects a nearby POI coordinate onto the route', () => {
    const result = projectPointToRoute(
        { lng: 104.001, lat: 30.002 },
        [[104, 30], [104.01, 30]],
    );

    assert.ok(Math.abs(result.lng - 104.001) < 1e-9);
    assert.ok(Math.abs(result.lat - 30) < 1e-9);
});

test('getMovingRoutePosition also corrects old moving state coordinates', () => {
    const result = getMovingRoutePosition({
        mode: 'moving',
        from: { lng: 104.001, lat: 30.002 },
        polyline: [[104, 30], [104.01, 30]],
    });

    assert.deepEqual(result, { lng: 104.001, lat: 30 });
});

test('placeLabelsReferToSameLocation accepts a previous campus and its parent shorthand', () => {
    assert.equal(
        placeLabelsReferToSameLocation(
            '成都市第二人民医院',
            '成都市第二人民医院龙潭院区',
        ),
        true,
    );
    assert.equal(
        placeLabelsReferToSameLocation(
            '成都市第二人民医院庆云院区',
            '成都市第二人民医院龙潭院区',
        ),
        false,
    );
});

test('getPointAlongRoute advances by route length instead of point count', () => {
    const result = getPointAlongRoute(
        [[104, 30], [104.01, 30], [104.03, 30]],
        0.5,
    );

    assert.ok(Math.abs(result.lng - 104.015) < 1e-9);
    assert.ok(Math.abs(result.lat - 30) < 1e-9);
});

test('getMovingProgress uses narrative elapsed time and keeps moving before destination', () => {
    assert.equal(getMovingProgress(15, 30), 0.5);
    assert.equal(getMovingProgress(40, 30), 0.98);
    assert.equal(getMovingProgress(0, 30), 0);
    assert.equal(getMovingProgress(10, 0), 0);
});

test('splitRouteAtProgress divides traveled and remaining paths at the exact position', () => {
    const result = splitRouteAtProgress(
        [[104, 30], [104.01, 30], [104.03, 30]],
        0.5,
    );

    assert.deepEqual(result.traveled, [
        { lng: 104, lat: 30 },
        { lng: 104.01, lat: 30 },
        { lng: 104.015, lat: 30 },
    ]);
    assert.deepEqual(result.remaining, [
        { lng: 104.015, lat: 30 },
        { lng: 104.03, lat: 30 },
    ]);
});

test('addAmapRoutePolyline creates a white border and a blue directional route', () => {
    class Polyline {
        constructor(options) {
            this.options = options;
        }
    }
    const additions = [];
    const map = { add: overlays => additions.push(overlays) };
    const overlays = addAmapRoutePolyline(map, { Polyline }, [[104, 30], [104.01, 30.01]]);

    assert.equal(overlays.length, 2);
    assert.equal(overlays[0].options.strokeColor, '#ffffff');
    assert.equal(overlays[0].options.strokeWeight, 12);
    assert.equal(overlays[1].options.strokeColor, '#1677ff');
    assert.equal(overlays[1].options.strokeWeight, 8);
    assert.equal(overlays[1].options.showDir, true);
    assert.equal(overlays[1].options.dirColor, '#ffffff');
    assert.deepEqual(additions[0], overlays);
});

test('addAmapRoutePolyline renders traveled route gray and remaining route blue', () => {
    class Polyline {
        constructor(options) {
            this.options = options;
        }
    }
    const additions = [];
    const map = { add: overlays => additions.push(overlays) };
    const overlays = addAmapRoutePolyline(
        map,
        { Polyline },
        [[104, 30], [104.02, 30]],
        { progressRatio: 0.5 },
    );

    assert.equal(overlays.length, 3);
    assert.equal(overlays[0].options.strokeColor, '#ffffff');
    assert.equal(overlays[1].options.strokeColor, '#9aa0a6');
    assert.deepEqual(overlays[1].options.path[0], [104, 30]);
    assert.ok(Math.abs(overlays[1].options.path[1][0] - 104.01) < 1e-12);
    assert.equal(overlays[1].options.path[1][1], 30);
    assert.equal(overlays[1].options.showDir, undefined);
    assert.equal(overlays[2].options.strokeColor, '#1677ff');
    assert.ok(Math.abs(overlays[2].options.path[0][0] - 104.01) < 1e-12);
    assert.equal(overlays[2].options.path[0][1], 30);
    assert.deepEqual(overlays[2].options.path[1], [104.02, 30]);
    assert.equal(overlays[2].options.showDir, true);
});

test('createAmapDestinationMarker recolors the standard AMap marker consistently', () => {
    class Marker {
        constructor(options) {
            this.options = options;
        }
    }
    const marker = createAmapDestinationMarker(
        { Marker },
        { lng: 104, lat: 30 },
        { extData: { realmap: 'yellow' } },
    );

    assert.deepEqual(marker.options.position, [104, 30]);
    assert.match(marker.options.content, /mark_r\.png/i);
    assert.match(marker.options.content, /width:19px;height:33px/i);
    assert.match(marker.options.content, /hue-rotate\(60deg\)/i);
    assert.equal(marker.options.extData.realmap, 'yellow');
});
