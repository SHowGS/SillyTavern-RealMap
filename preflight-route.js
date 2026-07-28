import { refinePlaceIntentFromNarrative } from './place-search.js';

export const PREFLIGHT_TOTAL_TIMEOUT_MS = 15_000;
export const PREFLIGHT_CONTEXT_MAX_CHARS = 1600;
export const ALL_ROUTE_MODES = Object.freeze(['walking', 'riding', 'driving', 'transfer']);

const ROUTE_LABELS = Object.freeze({
    walking: '步行',
    riding: '骑行',
    driving: '驾车',
    transfer: '公交',
});
const ROUTE_MODE_ALIASES = Object.freeze({
    walk: 'walking',
    walking: 'walking',
    bike: 'riding',
    bicycle: 'riding',
    cycling: 'riding',
    riding: 'riding',
    car: 'driving',
    drive: 'driving',
    driving: 'driving',
    taxi: 'driving',
    bus: 'transfer',
    metro: 'transfer',
    subway: 'transfer',
    transit: 'transfer',
    transfer: 'transfer',
});

export function shouldArmPreflightGeneration({
    type,
    automaticTrigger = false,
    dryRun = false,
    userText = '',
} = {}) {
    return !dryRun
        && !automaticTrigger
        && (type === undefined || type === 'normal')
        && Boolean(String(userText).trim());
}

export function shouldRunFreshPreflightAtStart({
    type,
    groupActive = false,
} = {}) {
    return !groupActive && ['regenerate', 'swipe'].includes(type);
}

export class PreflightEventGate {
    constructor() {
        this.armed = false;
        this.groupActive = false;
    }

    arm(options) {
        this.armed = shouldArmPreflightGeneration(options);
        return this.armed;
    }

    consume(isUserMessage) {
        const shouldRun = this.armed && Boolean(isUserMessage);
        this.armed = false;
        return shouldRun;
    }

    disarm() {
        this.armed = false;
    }

    startGroup() {
        this.groupActive = true;
        this.disarm();
    }

    finishGroup() {
        this.groupActive = false;
        this.disarm();
    }
}

function normalizeRouteModes(value) {
    const values = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    return [...new Set(values
        .map(mode => ROUTE_MODE_ALIASES[String(mode ?? '').trim().toLowerCase()])
        .filter(mode => ALL_ROUTE_MODES.includes(mode)))];
}

export function normalizePreflightIntent(value, narrativeTexts = []) {
    if (!value || typeof value !== 'object' || value.action !== 'route') {
        return { action: 'none' };
    }

    const texts = Array.isArray(narrativeTexts) ? narrativeTexts : [narrativeTexts];
    const to = refinePlaceIntentFromNarrative(value.to, texts);
    if (!to.full) return { action: 'none' };

    let from = null;
    if (value.from) {
        const normalizedFrom = refinePlaceIntentFromNarrative(value.from, texts);
        if (normalizedFrom.full) from = normalizedFrom;
    }
    return {
        action: 'route',
        from,
        to,
        modes: normalizeRouteModes(value.modes),
    };
}

export function getRouteModes(modes) {
    const normalized = normalizeRouteModes(modes);
    return normalized.length ? normalized : [...ALL_ROUTE_MODES];
}

function remainingMs(deadline) {
    return Math.max(0, Number(deadline) - Date.now());
}

function runAmapCallback(start, deadline, signal = null) {
    return new Promise((resolve) => {
        const timeoutMs = remainingMs(deadline);
        if (timeoutMs <= 0 || signal?.aborted) {
            resolve(null);
            return;
        }
        let settled = false;
        let timer = null;
        const onAbort = () => finish(null);
        const finish = (value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
        };
        timer = setTimeout(() => finish(null), timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            start((status, result) => finish(status === 'complete' ? result : null));
        } catch (_) {
            finish(null);
        }
    });
}

function getAddressCity(component) {
    const city = component?.city;
    if (typeof city === 'string' && city && city !== '[]') return city;
    const province = component?.province;
    return typeof province === 'string' ? province : '';
}

async function reverseGeocodeCity(AMap, point, deadline, signal) {
    if (!AMap?.Geocoder || !point) return '';
    const geocoder = new AMap.Geocoder();
    const result = await runAmapCallback(
        callback => geocoder.getAddress([point.lng, point.lat], callback),
        deadline,
        signal,
    );
    return getAddressCity(result?.regeocode?.addressComponent);
}

function sanitizeStep(value) {
    return String(value ?? '')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
}

function selectKeySteps(values, limit = 3) {
    const unique = [...new Set(values.map(sanitizeStep).filter(Boolean))];
    if (unique.length <= limit) return unique;
    const indices = [0, Math.floor((unique.length - 1) / 2), unique.length - 1];
    return [...new Set(indices.map(index => unique[index]))].slice(0, limit);
}

function getTransferStep(segment) {
    if (!segment || segment.transit_mode === 'WALK') return '';
    const transit = segment.transit;
    const line = transit?.lines?.[0]?.name;
    const instruction = line || segment.instruction;
    if (!instruction) return '';
    const onStation = transit?.on_station?.name;
    const offStation = transit?.off_station?.name;
    return onStation && offStation
        ? `${instruction}（${onStation}→${offStation}）`
        : instruction;
}

export function summarizeRouteResult(mode, result) {
    if (!ALL_ROUTE_MODES.includes(mode) || !result) return null;
    const route = mode === 'transfer' ? result.plans?.[0] : result.routes?.[0];
    if (!route) return null;

    const distance = Number(route.distance);
    const time = Number(route.time);
    if (!Number.isFinite(distance) || distance < 0 || !Number.isFinite(time) || time < 0) {
        return null;
    }

    let stepTexts;
    if (mode === 'transfer') {
        stepTexts = (route.segments || []).map(getTransferStep);
    } else if (mode === 'riding') {
        stepTexts = (route.rides || route.steps || []).map(step => step?.instruction || step?.road);
    } else {
        stepTexts = (route.steps || []).map(step => step?.instruction || step?.road);
    }

    const summary = {
        mode,
        distance_m: Math.round(distance),
        duration_min: Math.max(1, Math.round(time / 60)),
        key_steps: selectKeySteps(stepTexts),
    };
    if (mode === 'transfer') {
        const walkingDistance = Number(route.walking_distance);
        if (Number.isFinite(walkingDistance) && walkingDistance >= 0) {
            summary.walking_distance_m = Math.round(walkingDistance);
        }
        if (route.cost !== undefined && route.cost !== null && String(route.cost).trim()) {
            summary.cost = String(route.cost).trim();
        }
    }
    return summary;
}

function createRouteService(AMap, mode, transferCity = '') {
    if (mode === 'walking' && AMap?.Walking) return new AMap.Walking({});
    if (mode === 'riding' && AMap?.Riding) return new AMap.Riding({ policy: 0 });
    if (mode === 'driving' && AMap?.Driving) {
        return new AMap.Driving({ extensions: 'all' });
    }
    if (mode === 'transfer' && AMap?.Transfer && transferCity) {
        return new AMap.Transfer({
            city: transferCity,
            cityd: transferCity,
            policy: 0,
            extensions: 'all',
        });
    }
    return null;
}

async function queryRouteMode(AMap, mode, from, to, deadline, transferCity = '', signal = null) {
    const service = createRouteService(AMap, mode, transferCity);
    if (!service) return null;
    const useLngLat = mode === 'transfer' && typeof AMap.LngLat === 'function';
    const origin = useLngLat ? new AMap.LngLat(from.lng, from.lat) : [from.lng, from.lat];
    const destination = useLngLat ? new AMap.LngLat(to.lng, to.lat) : [to.lng, to.lat];
    const result = await runAmapCallback(
        callback => service.search(origin, destination, callback),
        deadline,
        signal,
    );
    return summarizeRouteResult(mode, result);
}

export async function queryRouteOptions(AMap, {
    from,
    to,
    modes = [],
    deadline = Date.now() + PREFLIGHT_TOTAL_TIMEOUT_MS,
    signal = null,
} = {}) {
    if (!from || !to || signal?.aborted) return [];
    const requestedModes = getRouteModes(modes);
    const tasks = requestedModes.map(async (mode) => {
        if (mode !== 'transfer') {
            return queryRouteMode(AMap, mode, from, to, deadline, '', signal);
        }
        const [fromCity, toCity] = await Promise.all([
            reverseGeocodeCity(AMap, from, deadline, signal),
            reverseGeocodeCity(AMap, to, deadline, signal),
        ]);
        if (signal?.aborted || !fromCity || !toCity || fromCity !== toCity) return null;
        return queryRouteMode(AMap, mode, from, to, deadline, fromCity, signal);
    });
    const settled = await Promise.allSettled(tasks);
    return settled
        .filter(result => result.status === 'fulfilled' && result.value)
        .map(result => result.value);
}

function formatDistance(distanceM) {
    const distance = Number(distanceM);
    if (!Number.isFinite(distance)) return '';
    if (distance < 1000) return `${Math.round(distance)}米`;
    return `${(distance / 1000).toFixed(1)}公里`;
}

function formatRouteLine(route) {
    const label = ROUTE_LABELS[route?.mode];
    if (!label) return '';
    const parts = [`${label}：${formatDistance(route.distance_m)}，约${route.duration_min}分钟`];
    if (route.mode === 'transfer' && Number.isFinite(route.walking_distance_m)) {
        parts.push(`步行${formatDistance(route.walking_distance_m)}`);
    }
    if (route.mode === 'transfer' && route.cost) {
        parts.push(`费用约${route.cost}元`);
    }
    if (Array.isArray(route.key_steps) && route.key_steps.length) {
        parts.push(`关键路径：${route.key_steps.join('；')}`);
    }
    return parts.join('；');
}

export function formatPreflightContext(metadata, maxChars = PREFLIGHT_CONTEXT_MAX_CHARS) {
    if (!metadata?.from?.label || !metadata?.to?.label || !Array.isArray(metadata.routes)) return '';
    const header = [
        '[现实地图·本轮移动参考]',
        `起点：${metadata.from.label}`,
        `目的地：${metadata.to.label}`,
    ];
    const footer = '以上为地图估算，仅供生成本轮剧情。结合用户明确选择描写过程，不要声称角色已经抵达。';
    const lines = [...header];
    for (const route of metadata.routes) {
        const line = formatRouteLine(route);
        if (!line) continue;
        const candidate = [...lines, line, footer].join('\n');
        if (candidate.length <= maxChars) {
            lines.push(line);
            continue;
        }
        const remaining = maxChars - [...lines, footer].join('\n').length - 2;
        if (remaining > 20) lines.push(line.slice(0, remaining));
        break;
    }
    const result = [...lines, footer].join('\n');
    return result.slice(0, maxChars);
}
