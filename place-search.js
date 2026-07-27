export const DEFAULT_NEARBY_RADIUS_METERS = 50000;

function normalizeText(value) {
    return String(value ?? '')
        .toLocaleLowerCase()
        .replace(/\s+/g, '')
        .replace(/[()（）[\]【】·•,，.。\-_/\\]/g, '');
}

function getPoiLocation(poi) {
    const location = poi?.location;
    if (!location) return null;
    const lng = typeof location.getLng === 'function' ? location.getLng() : Number(location.lng);
    const lat = typeof location.getLat === 'function' ? location.getLat() : Number(location.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    return { lng, lat };
}

function getCandidateText(poi) {
    return [
        poi?.name,
        poi?.pname,
        poi?.cityname,
        poi?.adname,
        poi?.address,
        poi?.type,
    ].filter(Boolean).join('');
}

function calculateHaversineDistance(origin, destination) {
    const toRadians = degrees => degrees * Math.PI / 180;
    const earthRadiusMeters = 6371008.8;
    const lat1 = toRadians(origin.lat);
    const lat2 = toRadians(destination.lat);
    const deltaLat = lat2 - lat1;
    const deltaLng = toRadians(destination.lng - origin.lng);
    const sinLat = Math.sin(deltaLat / 2);
    const sinLng = Math.sin(deltaLng / 2);
    const a = sinLat * sinLat
        + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
    return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calculateDistance(AMap, poi, origin) {
    if (!origin || !Number.isFinite(origin.lng) || !Number.isFinite(origin.lat)) return Infinity;
    const location = getPoiLocation(poi);
    if (!location) return Infinity;
    try {
        const distance = AMap?.GeometryUtil?.distance?.(
            [origin.lng, origin.lat],
            [location.lng, location.lat],
        );
        if (Number.isFinite(distance)) return distance;
    } catch (_) {}

    const providedDistance = Number(poi?.distance);
    if (Number.isFinite(providedDistance)) return providedDistance;
    return calculateHaversineDistance(origin, location);
}

function scoreName(name, query) {
    const n = normalizeText(name);
    const q = normalizeText(query);
    if (!n || !q) return 0;
    if (n === q) return 300;
    if (n.startsWith(q)) return 220;
    if (q.startsWith(n)) return 200;
    if (n.includes(q)) return 160;
    if (q.includes(n)) return 140;
    return 0;
}

function scoreTextCoverage(poi, query) {
    const q = normalizeText(query);
    const text = normalizeText(getCandidateText(poi));
    if (!q || !text) return 0;
    if (text.includes(q)) return 120;

    const queryChars = [...new Set([...q].filter(char => /[\p{L}\p{N}]/u.test(char)))];
    if (!queryChars.length) return 0;
    const matched = queryChars.filter(char => text.includes(char)).length;
    return Math.round((matched / queryChars.length) * 80);
}

function scoreAdministrativeContext(poi, query) {
    const q = normalizeText(query);
    if (!q) return 0;
    const fields = [
        { value: poi?.pname, weight: 60 },
        { value: poi?.cityname, weight: 80 },
        { value: poi?.adname, weight: 50 },
    ];
    let score = 0;
    for (const field of fields) {
        const normalized = normalizeText(field.value);
        if (!normalized) continue;
        const shortName = normalized.replace(/(特别行政区|自治区|自治州|地区|省|市|区|县)$/u, '');
        if (q.includes(normalized) || (shortName.length >= 2 && q.includes(shortName))) {
            score += field.weight;
        }
    }
    return score;
}

function scoreDistance(distance) {
    if (!Number.isFinite(distance)) return 0;
    if (distance <= 1000) return 50;
    if (distance <= 5000) return 40;
    if (distance <= 20000) return 25;
    if (distance <= DEFAULT_NEARBY_RADIUS_METERS) return 10;
    return -Math.min(30, Math.round(Math.log10(distance / DEFAULT_NEARBY_RADIUS_METERS + 1) * 20));
}

function candidateKey(poi) {
    if (poi?.id) return `id:${poi.id}`;
    const location = getPoiLocation(poi);
    if (location) {
        return `loc:${normalizeText(poi?.name)}:${location.lng.toFixed(6)}:${location.lat.toFixed(6)}`;
    }
    return `text:${normalizeText(poi?.name)}:${normalizeText(poi?.address)}`;
}

function runPlaceSearch(searcher, method, args) {
    return new Promise((resolve) => {
        const callback = (status, result) => {
            resolve(status === 'complete' && Array.isArray(result?.poiList?.pois)
                ? result.poiList.pois
                : []);
        };
        try {
            searcher[method](...args, callback);
        } catch (_) {
            resolve([]);
        }
    });
}

/**
 * 合并全国搜索与附近搜索，并使用同一套规则去重和评分。
 *
 * 返回项结构：
 * { poi, score, distance, sources: Set<'national'|'nearby'> }
 */
export async function searchRankedPlaces(AMap, query, {
    origin = null,
    radius = DEFAULT_NEARBY_RADIUS_METERS,
    city = '全国',
    pageSize = 20,
    maxResults = 20,
} = {}) {
    const normalizedQuery = String(query ?? '').trim();
    if (!normalizedQuery || !AMap?.PlaceSearch) return [];

    const nationalSearcher = new AMap.PlaceSearch({
        city,
        citylimit: false,
        pageSize,
        pageIndex: 1,
    });
    const tasks = [{
        source: 'national',
        promise: runPlaceSearch(nationalSearcher, 'search', [normalizedQuery]),
    }];

    if (origin && Number.isFinite(origin.lng) && Number.isFinite(origin.lat)) {
        const nearbySearcher = new AMap.PlaceSearch({
            pageSize,
            pageIndex: 1,
        });
        tasks.push({
            source: 'nearby',
            promise: runPlaceSearch(nearbySearcher, 'searchNearBy', [
                normalizedQuery,
                [origin.lng, origin.lat],
                radius,
            ]),
        });
    }

    const settled = await Promise.allSettled(tasks.map(task => task.promise));
    const merged = new Map();
    settled.forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        const source = tasks[index].source;
        for (const poi of result.value) {
            if (!getPoiLocation(poi)) continue;
            const key = candidateKey(poi);
            const existing = merged.get(key);
            if (existing) {
                existing.sources.add(source);
            } else {
                merged.set(key, { poi, sources: new Set([source]) });
            }
        }
    });

    return [...merged.values()]
        .map((entry) => {
            const distance = calculateDistance(AMap, entry.poi, origin);
            const sourceBonus = entry.sources.has('nearby') ? 25 : 0;
            const score = scoreName(entry.poi?.name, normalizedQuery)
                + scoreTextCoverage(entry.poi, normalizedQuery)
                + scoreAdministrativeContext(entry.poi, normalizedQuery)
                + sourceBonus
                + scoreDistance(distance);
            return { ...entry, score, distance };
        })
        .sort((a, b) => {
            if (a.score !== b.score) return b.score - a.score;
            if (a.distance !== b.distance) return a.distance - b.distance;
            return String(a.poi?.name ?? '').localeCompare(String(b.poi?.name ?? ''), 'zh-CN');
        })
        .slice(0, maxResults);
}

export function getRankedPoiLocation(rankedCandidate) {
    return getPoiLocation(rankedCandidate?.poi);
}
