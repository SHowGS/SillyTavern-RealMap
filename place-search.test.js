import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normalizePlaceIntent,
    refinePlaceIntentFromNarrative,
    resolveNarrativePlace,
    searchRankedPlaces,
} from './place-search.js';

const HOSPITAL = '成都市第二人民医院';
const FULL_OUTPATIENT = `${HOSPITAL}门诊楼`;

function makePoi({
    id,
    name,
    lng = 104.08,
    lat = 30.67,
    cityname = '成都市',
    address = '成都市',
    parent = '',
    children,
} = {}) {
    return {
        id,
        name,
        cityname,
        address,
        parent,
        location: { lng, lat },
        ...(children ? { children } : {}),
    };
}

function createFakeAMap({
    search = {},
    nearby = {},
    hangingSearches = new Set(),
} = {}) {
    const calls = [];
    class PlaceSearch {
        constructor(options) {
            this.options = options;
            calls.push({ method: 'construct', options });
        }

        search(query, callback) {
            calls.push({ method: 'search', query, options: this.options });
            if (hangingSearches.has(query)) return;
            queueMicrotask(() => callback('complete', {
                poiList: { pois: search[query] || [] },
            }));
        }

        searchNearBy(query, center, radius, callback) {
            calls.push({
                method: 'searchNearBy',
                query,
                center,
                radius,
                options: this.options,
            });
            queueMicrotask(() => callback('complete', {
                poiList: { pois: nearby[query] || [] },
            }));
        }
    }

    const GeometryUtil = {
        distance([lng1, lat1], [lng2, lat2]) {
            return Math.hypot(lng2 - lng1, lat2 - lat1) * 111000;
        },
    };
    return { PlaceSearch, GeometryUtil, calls };
}

function structuredOutpatient(overrides = {}) {
    return {
        full: FULL_OUTPATIENT,
        city: '成都市',
        parent: HOSPITAL,
        subplace: '门诊楼',
        kind: 'building',
        ...overrides,
    };
}

test('normalizes structured and legacy hierarchical places', () => {
    assert.deepEqual(normalizePlaceIntent(FULL_OUTPATIENT), {
        full: FULL_OUTPATIENT,
        city: '成都市',
        parent: HOSPITAL,
        subplace: '门诊楼',
        kind: 'building',
        hierarchical: true,
    });

    assert.deepEqual(normalizePlaceIntent({
        parent: HOSPITAL,
        subplace: 'A座',
        city: '成都市',
        kind: 'building',
    }), {
        full: `${HOSPITAL}A座`,
        city: '成都市',
        parent: HOSPITAL,
        subplace: 'A座',
        kind: 'building',
        hierarchical: true,
    });

    assert.equal(normalizePlaceIntent({
        full: FULL_OUTPATIENT,
        city: '成都市',
        parent: HOSPITAL,
        subplace: '门诊楼',
        kind: 'unknown',
    }).kind, 'building');
    assert.equal(
        normalizePlaceIntent(`四川省${FULL_OUTPATIENT}`).city,
        '成都市',
    );
    assert.equal(normalizePlaceIntent({
        ...structuredOutpatient(),
        city: '四川省成都市',
    }).city, '成都市');
});

test('restores an omitted hospital campus from an explicit narrative place', () => {
    assert.deepEqual(
        refinePlaceIntentFromNarrative(HOSPITAL, [
            `她走进${HOSPITAL}龙潭院区，在大厅停下。`,
        ]),
        {
            full: `${HOSPITAL}龙潭院区`,
            city: '成都市',
            parent: HOSPITAL,
            subplace: '龙潭院区',
            kind: 'campus',
            hierarchical: true,
        },
    );
});

test('inserts an omitted campus between a parent place and its building', () => {
    assert.deepEqual(
        refinePlaceIntentFromNarrative(structuredOutpatient(), [
            `user位于${HOSPITAL}龙潭院区门诊楼。`,
        ]),
        {
            full: `${HOSPITAL}龙潭院区门诊楼`,
            city: '成都市',
            parent: `${HOSPITAL}龙潭院区`,
            subplace: '门诊楼',
            kind: 'building',
            hierarchical: true,
        },
    );
});

test('restores school campuses and skips ambiguous campus narratives', () => {
    const university = '四川大学';
    assert.equal(
        refinePlaceIntentFromNarrative(university, ['user正在四川大学江安校区。']).full,
        '四川大学江安校区',
    );
    assert.equal(
        refinePlaceIntentFromNarrative(HOSPITAL, [
            `车辆从${HOSPITAL}庆云院区驶向${HOSPITAL}龙潭院区。`,
        ]).full,
        HOSPITAL,
    );
    assert.equal(
        refinePlaceIntentFromNarrative(HOSPITAL, [
            `她离开${HOSPITAL}龙潭院区，随后回到${HOSPITAL}。`,
        ]).full,
        HOSPITAL,
    );
    assert.equal(
        refinePlaceIntentFromNarrative(HOSPITAL, [
            `${HOSPITAL}目前位于龙潭院区附近。`,
        ]).full,
        HOSPITAL,
    );
});

test('resolves the Longtan campus after repairing a generic hospital result', async () => {
    const corrected = refinePlaceIntentFromNarrative(HOSPITAL, [
        `user位于${HOSPITAL}龙潭院区。`,
    ]);
    const main = makePoi({
        id: 'main',
        name: HOSPITAL,
        lng: 104.08,
    });
    const longtan = makePoi({
        id: 'longtan',
        name: `${HOSPITAL}龙潭院区`,
        lng: 104.20,
    });
    const AMap = createFakeAMap({
        search: {
            [corrected.full]: [longtan, main],
            [HOSPITAL]: [main, longtan],
        },
    });

    const result = await resolveNarrativePlace(AMap, corrected);
    assert.equal(result.poi.id, 'longtan');
    assert.equal(result.label, `${HOSPITAL}龙潭院区`);
    assert.equal(result.strategy, 'exact-full');
});

test('exact outpatient building beats a nearby cosmetic department', async () => {
    const parent = makePoi({ id: 'hospital', name: HOSPITAL });
    const beauty = makePoi({
        id: 'beauty',
        name: `${HOSPITAL}医疗美容科`,
        lng: 104.08001,
        parent: 'hospital',
    });
    const outpatient = makePoi({
        id: 'outpatient',
        name: FULL_OUTPATIENT,
        lng: 104.081,
        parent: 'hospital',
    });
    const AMap = createFakeAMap({
        search: {
            [FULL_OUTPATIENT]: [beauty, outpatient],
            [HOSPITAL]: [parent],
        },
    });

    const result = await resolveNarrativePlace(AMap, structuredOutpatient());
    assert.equal(result.poi.id, 'outpatient');
    assert.equal(result.label, FULL_OUTPATIENT);
    assert.equal(result.strategy, 'exact-full');
    assert.equal(result.confidence, 'high');
    assert.equal(result.parentPoi.id, 'hospital');
    assert.ok(AMap.calls
        .filter(call => call.method === 'construct')
        .every(call => call.options.children === 1
            && call.options.extensions === 'all'
            && call.options.pageSize === 50
            && call.options.citylimit === true));
});

test('flattens nested children and accepts a parent-linked outpatient synonym', async () => {
    const beauty = makePoi({
        id: 'beauty',
        name: `${HOSPITAL}医疗美容科`,
        parent: { id: 'hospital' },
    });
    const comprehensive = makePoi({
        id: 'comprehensive',
        name: `${HOSPITAL}诊疗楼`,
        lng: 104.081,
    });
    comprehensive.location = '104.081,30.67';
    const parent = makePoi({
        id: 'hospital',
        name: HOSPITAL,
        children: [beauty, comprehensive],
    });
    const AMap = createFakeAMap({
        search: {
            [FULL_OUTPATIENT]: [beauty],
            [HOSPITAL]: [parent],
        },
    });

    const result = await resolveNarrativePlace(AMap, structuredOutpatient());
    assert.equal(result.poi.id, 'comprehensive');
    assert.equal(result.strategy, 'synonym-child');
    assert.equal(result.parentPoi.id, 'hospital');
});

test('uses a nearby compatible building but rejects a closer department', async () => {
    const parent = makePoi({ id: 'hospital', name: HOSPITAL });
    const beauty = makePoi({
        id: 'beauty',
        name: `${HOSPITAL}医疗美容科`,
        lng: 104.08001,
        parent: 'hospital',
    });
    const comprehensive = makePoi({
        id: 'building',
        name: `${HOSPITAL}综合楼`,
        lng: 104.081,
        parent: 'hospital',
    });
    const AMap = createFakeAMap({
        search: {
            [FULL_OUTPATIENT]: [beauty],
            [HOSPITAL]: [parent],
        },
        nearby: {
            门诊楼: [beauty, comprehensive],
        },
    });

    const result = await resolveNarrativePlace(AMap, structuredOutpatient());
    assert.equal(result.poi.id, 'building');
    assert.equal(result.strategy, 'nearest-compatible-building');
    assert.notEqual(result.poi.id, 'beauty');
});

test('rejects a department-qualified outpatient building in favor of a general clinic building', async () => {
    const risky = makePoi({
        id: 'risky',
        name: `${HOSPITAL}医疗美容科门诊楼`,
        lng: 104.08001,
        parent: 'hospital',
    });
    const clinic = makePoi({
        id: 'clinic',
        name: `${HOSPITAL}诊疗楼`,
        lng: 104.082,
        parent: 'hospital',
    });
    const parent = makePoi({
        id: 'hospital',
        name: HOSPITAL,
        children: [risky, clinic],
    });
    const AMap = createFakeAMap({
        search: {
            [FULL_OUTPATIENT]: [risky],
            [HOSPITAL]: [parent],
        },
    });

    const result = await resolveNarrativePlace(AMap, structuredOutpatient({
        kind: 'unknown',
    }));
    assert.equal(result.poi.id, 'clinic');
    assert.equal(result.strategy, 'synonym-child');
});

test('falls back to the parent hospital instead of a cosmetic department', async () => {
    const parent = makePoi({ id: 'hospital', name: HOSPITAL });
    const beauty = makePoi({
        id: 'beauty',
        name: `${HOSPITAL}医疗美容科`,
        lng: 104.08001,
        parent: 'hospital',
    });
    const AMap = createFakeAMap({
        search: {
            [FULL_OUTPATIENT]: [beauty],
            [HOSPITAL]: [parent],
        },
    });

    const result = await resolveNarrativePlace(AMap, structuredOutpatient());
    assert.equal(result.poi.id, 'hospital');
    assert.equal(result.label, FULL_OUTPATIENT);
    assert.equal(result.strategy, 'parent-fallback');
    assert.equal(result.confidence, 'low');
});

test('uses story continuity to choose among matching campuses', async () => {
    const main = makePoi({
        id: 'main',
        name: HOSPITAL,
        lng: 104.08,
    });
    const longtan = makePoi({
        id: 'longtan',
        name: `${HOSPITAL}龙潭院区`,
        lng: 104.20,
    });
    const AMap = createFakeAMap({
        search: {
            [FULL_OUTPATIENT]: [],
            [HOSPITAL]: [main, longtan],
        },
    });

    const result = await resolveNarrativePlace(AMap, structuredOutpatient(), {
        origin: { lng: 104.201, lat: 30.67 },
    });
    assert.equal(result.poi.id, 'longtan');
    assert.equal(result.strategy, 'parent-fallback');
});

test('an explicitly named campus overrides a closer previous location', async () => {
    const explicitParent = `${HOSPITAL}龙潭院区`;
    const explicitFull = `${explicitParent}门诊楼`;
    const main = makePoi({
        id: 'main',
        name: HOSPITAL,
        lng: 104.08,
    });
    const longtan = makePoi({
        id: 'longtan',
        name: explicitParent,
        lng: 104.20,
    });
    longtan.location = [104.20, 30.67];
    const AMap = createFakeAMap({
        search: {
            [explicitFull]: [],
            [explicitParent]: [main, longtan],
        },
    });

    const result = await resolveNarrativePlace(AMap, {
        full: explicitFull,
        city: '成都市',
        parent: explicitParent,
        subplace: '门诊楼',
        kind: 'building',
    }, {
        origin: { lng: 104.0801, lat: 30.67 },
    });
    assert.equal(result.poi.id, 'longtan');
    assert.equal(result.strategy, 'parent-fallback');
});

test('does not silently replace a missing explicitly named campus with the main campus', async () => {
    const explicitParent = `${HOSPITAL}龙潭院区`;
    const explicitFull = `${explicitParent}门诊楼`;
    const main = makePoi({
        id: 'main',
        name: HOSPITAL,
        lng: 104.08,
    });
    const AMap = createFakeAMap({
        search: {
            [explicitFull]: [],
            [explicitParent]: [main],
        },
    });

    const result = await resolveNarrativePlace(AMap, {
        full: explicitFull,
        city: '成都市',
        parent: explicitParent,
        subplace: '门诊楼',
        kind: 'building',
    }, {
        origin: { lng: 104.0801, lat: 30.67 },
    });
    assert.equal(result, null);
});

test('does not fall back to a main campus for an unresolved campus subplace', async () => {
    const explicitFull = `${HOSPITAL}龙潭院区`;
    const main = makePoi({
        id: 'main',
        name: HOSPITAL,
        lng: 104.08,
    });
    const AMap = createFakeAMap({
        search: {
            [explicitFull]: [],
            [HOSPITAL]: [main],
        },
    });

    const result = await resolveNarrativePlace(AMap, {
        full: explicitFull,
        city: '成都市',
        parent: HOSPITAL,
        subplace: '龙潭院区',
        kind: 'campus',
    });
    assert.equal(result, null);
});

test('rejects a parent candidate from the wrong city', async () => {
    const wrongCity = makePoi({
        id: 'wrong',
        name: HOSPITAL,
        cityname: '重庆市',
        address: '重庆市',
    });
    const correctCity = makePoi({
        id: 'correct',
        name: HOSPITAL,
        cityname: '成都市',
        address: '成都市',
        lng: 104.09,
    });
    const AMap = createFakeAMap({
        search: {
            [FULL_OUTPATIENT]: [],
            [HOSPITAL]: [wrongCity, correctCity],
        },
    });

    const result = await resolveNarrativePlace(AMap, structuredOutpatient());
    assert.equal(result.poi.id, 'correct');
});

test('rejects an unlinked exact child outside the 500 meter parent boundary', async () => {
    const parent = makePoi({ id: 'hospital', name: HOSPITAL });
    const unrelated = makePoi({
        id: 'unrelated',
        name: '门诊楼',
        lng: 104.086,
        address: '成都市其他机构',
    });
    const AMap = createFakeAMap({
        search: {
            [FULL_OUTPATIENT]: [unrelated],
            [HOSPITAL]: [parent],
        },
        nearby: {
            门诊楼: [unrelated],
        },
    });

    const result = await resolveNarrativePlace(AMap, structuredOutpatient());
    assert.equal(result.poi.id, 'hospital');
    assert.equal(result.strategy, 'parent-fallback');
});

test('accepts an unlinked exact child inside the 500 meter parent boundary', async () => {
    const parent = makePoi({ id: 'hospital', name: HOSPITAL });
    const nearbyChild = makePoi({
        id: 'nearby-child',
        name: '门诊楼',
        lng: 104.083,
        address: '成都市庆云南街',
    });
    const AMap = createFakeAMap({
        search: {
            [FULL_OUTPATIENT]: [nearbyChild],
            [HOSPITAL]: [parent],
        },
    });

    const result = await resolveNarrativePlace(AMap, structuredOutpatient());
    assert.equal(result.poi.id, 'nearby-child');
    assert.equal(result.strategy, 'exact-child');
});

test('keeps successful parent results when the full-name search times out', async () => {
    const child = makePoi({
        id: 'outpatient',
        name: '门诊楼',
    });
    const parent = makePoi({
        id: 'hospital',
        name: HOSPITAL,
        children: [child],
    });
    const AMap = createFakeAMap({
        search: {
            [HOSPITAL]: [parent],
        },
        hangingSearches: new Set([FULL_OUTPATIENT]),
    });

    const result = await resolveNarrativePlace(AMap, structuredOutpatient(), {
        timeoutMs: 20,
    });
    assert.equal(result.poi.id, 'outpatient');
    assert.equal(result.strategy, 'exact-child');
});

test('releases hanging place searches immediately when aborted', async () => {
    const AMap = createFakeAMap({
        hangingSearches: new Set(['望京SOHO']),
    });
    const controller = new AbortController();
    const started = Date.now();
    const pending = searchRankedPlaces(AMap, '望京SOHO', {
        signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);

    assert.deepEqual(await pending, []);
    assert.ok(Date.now() - started < 200);
});

test('preserves the manual search return contract', async () => {
    const exact = makePoi({ id: 'exact', name: '望京SOHO' });
    const other = makePoi({ id: 'other', name: '望京SOHO塔楼' });
    const AMap = createFakeAMap({
        search: {
            望京SOHO: [other, exact],
        },
    });

    const ranked = await searchRankedPlaces(AMap, '望京SOHO');
    assert.equal(ranked[0].poi.id, 'exact');
    assert.equal(typeof ranked[0].score, 'number');
    assert.ok(ranked[0].sources instanceof Set);
});
