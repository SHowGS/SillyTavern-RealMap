import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ALL_ROUTE_MODES,
    PreflightEventGate,
    formatPreflightContext,
    getPreflightSourceFingerprint,
    getRouteModes,
    normalizePreflightIntent,
    queryRouteOptions,
    shouldArmPreflightGeneration,
    shouldRestoreGroupPreflight,
    summarizeRouteResult,
} from './preflight-route.js';

const HOSPITAL = '成都市第二人民医院';

function createRouteResult(mode) {
    if (mode === 'transfer') {
        return {
            plans: [{
                distance: 8200,
                time: 2100,
                walking_distance: 650,
                cost: 3,
                segments: [
                    {
                        transit_mode: 'SUBWAY',
                        transit: {
                            lines: [{ name: '地铁8号线' }],
                            on_station: { name: '东大路站' },
                            off_station: { name: '十里店站' },
                        },
                    },
                ],
            }],
        };
    }
    const steps = [
        { instruction: '沿第一大道向东' },
        { instruction: '右转进入第二大道' },
        { instruction: '经过第三大道' },
        { instruction: '左转进入第四大道' },
        { instruction: '抵达目的地' },
    ];
    const route = {
        distance: mode === 'walking' ? 2500 : 6000,
        time: mode === 'walking' ? 1800 : 1200,
        ...(mode === 'riding' ? { rides: steps } : { steps }),
    };
    return { routes: [route] };
}

function createFakeAMap({
    fromCity = '成都市',
    toCity = '成都市',
    hangingModes = [],
} = {}) {
    const calls = [];
    const hanging = new Set(hangingModes);
    const makeRouteClass = mode => class {
        constructor(options) {
            this.options = options;
            calls.push({ method: 'construct', mode, options });
        }

        search(origin, destination, callback) {
            calls.push({ method: 'search', mode, origin, destination });
            if (hanging.has(mode)) return;
            queueMicrotask(() => callback('complete', createRouteResult(mode)));
        }
    };

    class Geocoder {
        getAddress(point, callback) {
            const city = Number(point[0]) < 105 ? fromCity : toCity;
            queueMicrotask(() => callback('complete', {
                regeocode: { addressComponent: { city, province: city } },
            }));
        }
    }

    class LngLat {
        constructor(lng, lat) {
            this.lng = lng;
            this.lat = lat;
        }
    }

    return {
        AMap: {
            Walking: makeRouteClass('walking'),
            Riding: makeRouteClass('riding'),
            Driving: makeRouteClass('driving'),
            Transfer: makeRouteClass('transfer'),
            Geocoder,
            LngLat,
        },
        calls,
    };
}

test('arms only one preflight for a normal manual user message', () => {
    const gate = new PreflightEventGate();
    assert.equal(gate.arm({
        type: 'normal',
        automaticTrigger: false,
        dryRun: false,
        userText: '前往龙潭院区',
    }), true);
    assert.equal(gate.consume(true), true);
    assert.equal(gate.consume(true), false);

    assert.equal(shouldArmPreflightGeneration({
        type: 'regenerate',
        userText: '前往龙潭院区',
    }), false);
    assert.equal(shouldArmPreflightGeneration({
        type: 'normal',
        automaticTrigger: true,
        userText: '前往龙潭院区',
    }), false);
    assert.equal(shouldArmPreflightGeneration({
        type: 'normal',
        dryRun: true,
        userText: '前往龙潭院区',
    }), false);
});

test('tracks group lifecycle without arming duplicate messages', () => {
    const gate = new PreflightEventGate();
    gate.startGroup();
    assert.equal(gate.groupActive, true);
    assert.equal(gate.consume(true), false);
    gate.finishGroup();
    assert.equal(gate.groupActive, false);

    assert.equal(shouldRestoreGroupPreflight({
        type: 'normal',
        userText: '',
    }), true);
    assert.equal(shouldRestoreGroupPreflight({
        type: 'regenerate',
        userText: '',
    }), true);
    assert.equal(shouldRestoreGroupPreflight({
        type: 'auto',
        userText: '',
    }), false);
    assert.equal(shouldRestoreGroupPreflight({
        type: 'quiet',
        userText: '',
    }), false);
    assert.equal(shouldRestoreGroupPreflight({
        type: 'normal',
        userText: '新的用户输入',
    }), false);
});

test('fingerprints source messages for safe regeneration reuse', () => {
    const first = getPreflightSourceFingerprint('骑行前往龙潭院区');
    assert.equal(first, getPreflightSourceFingerprint('骑行前往龙潭院区'));
    assert.notEqual(first, getPreflightSourceFingerprint('步行前往龙潭院区'));
});

test('normalizes route intent and restores a missed hospital campus', () => {
    const result = normalizePreflightIntent({
        action: 'route',
        from: null,
        to: HOSPITAL,
        modes: ['riding', 'invalid', 'riding'],
    }, [`user想前往${HOSPITAL}龙潭院区。`]);

    assert.equal(result.action, 'route');
    assert.equal(result.from, null);
    assert.equal(result.to.full, `${HOSPITAL}龙潭院区`);
    assert.equal(result.to.subplace, '龙潭院区');
    assert.deepEqual(result.modes, ['riding']);
    assert.deepEqual(getRouteModes([]), [...ALL_ROUTE_MODES]);
    assert.deepEqual(getRouteModes(['metro', 'taxi']), ['transfer', 'driving']);
});

test('returns no action for missing or unreliable destinations', () => {
    assert.deepEqual(normalizePreflightIntent({ action: 'none' }), { action: 'none' });
    assert.deepEqual(normalizePreflightIntent({
        action: 'route',
        from: null,
        to: '',
        modes: [],
    }), { action: 'none' });
});

test('summarizes route results with at most three key steps', () => {
    const walking = summarizeRouteResult('walking', createRouteResult('walking'));
    assert.equal(walking.distance_m, 2500);
    assert.equal(walking.duration_min, 30);
    assert.deepEqual(walking.key_steps, [
        '沿第一大道向东',
        '经过第三大道',
        '抵达目的地',
    ]);

    const transfer = summarizeRouteResult('transfer', createRouteResult('transfer'));
    assert.equal(transfer.walking_distance_m, 650);
    assert.equal(transfer.cost, '3');
    assert.deepEqual(transfer.key_steps, ['地铁8号线（东大路站→十里店站）']);
});

test('queries every successful mode in parallel for a same-city trip', async () => {
    const { AMap, calls } = createFakeAMap();
    const routes = await queryRouteOptions(AMap, {
        from: { lng: 104.08, lat: 30.67 },
        to: { lng: 104.20, lat: 30.67 },
        modes: [],
        deadline: Date.now() + 1000,
    });

    assert.deepEqual(routes.map(route => route.mode), [...ALL_ROUTE_MODES]);
    const drivingOptions = calls.find(call => call.method === 'construct' && call.mode === 'driving').options;
    assert.equal(drivingOptions.extensions, 'all');
    const transferOptions = calls.find(call => call.method === 'construct' && call.mode === 'transfer').options;
    assert.equal(transferOptions.city, '成都市');
    assert.equal(transferOptions.cityd, '成都市');
});

test('queries only explicit modes and skips cross-city transfer', async () => {
    const explicit = createFakeAMap();
    const riding = await queryRouteOptions(explicit.AMap, {
        from: { lng: 104.08, lat: 30.67 },
        to: { lng: 104.20, lat: 30.67 },
        modes: ['riding'],
        deadline: Date.now() + 1000,
    });
    assert.deepEqual(riding.map(route => route.mode), ['riding']);
    assert.equal(explicit.calls.some(call => call.mode === 'walking'), false);

    const crossCity = createFakeAMap({ fromCity: '成都市', toCity: '重庆市' });
    const routes = await queryRouteOptions(crossCity.AMap, {
        from: { lng: 104.08, lat: 30.67 },
        to: { lng: 106.55, lat: 29.56 },
        modes: [],
        deadline: Date.now() + 1000,
    });
    assert.equal(routes.some(route => route.mode === 'transfer'), false);
    assert.equal(crossCity.calls.some(call => call.method === 'construct' && call.mode === 'transfer'), false);
});

test('drops hanging routes at the shared deadline', async () => {
    const { AMap } = createFakeAMap({ hangingModes: ['walking'] });
    const started = Date.now();
    const routes = await queryRouteOptions(AMap, {
        from: { lng: 104.08, lat: 30.67 },
        to: { lng: 104.20, lat: 30.67 },
        modes: ['walking'],
        deadline: Date.now() + 20,
    });
    assert.deepEqual(routes, []);
    assert.ok(Date.now() - started < 200);
});

test('releases hanging route callbacks immediately when aborted', async () => {
    const { AMap } = createFakeAMap({ hangingModes: ['walking'] });
    const controller = new AbortController();
    const started = Date.now();
    const pending = queryRouteOptions(AMap, {
        from: { lng: 104.08, lat: 30.67 },
        to: { lng: 104.20, lat: 30.67 },
        modes: ['walking'],
        deadline: Date.now() + 1000,
        signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    assert.deepEqual(await pending, []);
    assert.ok(Date.now() - started < 200);
});

test('formats bounded main-model context with route details', () => {
    const metadata = {
        from: { label: '成都市第二人民医院庆云院区', lng: 104.083421, lat: 30.671234 },
        to: { label: '成都市第二人民医院龙潭院区', lng: 104.157891, lat: 30.712345 },
        routes: [
            summarizeRouteResult('walking', createRouteResult('walking')),
            summarizeRouteResult('transfer', createRouteResult('transfer')),
        ],
    };
    const context = formatPreflightContext(metadata);
    assert.match(context, /^\[现实地图·本轮移动参考\]/u);
    assert.match(context, /步行：2\.5公里，约30分钟/u);
    assert.match(context, /公交：8\.2公里，约35分钟/u);
    assert.match(context, /不要声称角色已经抵达。$/u);
    assert.ok(context.length <= 1600);
    assert.doesNotMatch(context, /104\.083421|30\.671234|104\.157891|30\.712345/u);

    const oversized = formatPreflightContext({
        ...metadata,
        routes: ALL_ROUTE_MODES.map(mode => ({
            mode,
            distance_m: 12345,
            duration_min: 99,
            walking_distance_m: 500,
            cost: '10',
            key_steps: Array.from({ length: 3 }, (_, index) => `${'很长的关键道路'.repeat(20)}${index}`),
        })),
    });
    assert.ok(oversized.length <= 1600);
    assert.match(oversized, /不要声称角色已经抵达。$/u);
});
