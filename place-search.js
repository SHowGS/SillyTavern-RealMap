export const DEFAULT_NEARBY_RADIUS_METERS = 50000;
export const NARRATIVE_NEARBY_RADIUS_METERS = 800;
export const NARRATIVE_PARENT_PROXIMITY_METERS = 500;

const NARRATIVE_SEARCH_TIMEOUT_MS = 5000;
const NARRATIVE_PLACE_KINDS = new Set([
    'campus',
    'building',
    'department',
    'entrance',
    'station',
    'road',
    'community',
    'venue',
    'unknown',
]);
const BUILDING_MARKER = /(楼|栋|座|大厦|馆|大厅|门诊部|住院部|急诊部|航站楼|候机楼)/u;
const DEPARTMENT_MARKER = /(医疗美容|整形美容|专科门诊|科室|诊所|[\p{Script=Han}]{1,10}科(?=(?:$|门诊|诊疗|住院|急诊|楼|栋|座|大厦|馆)))/u;
const CAMPUS_MARKER = /(院区|校区|园区|分院|分部|本部)$/u;
const ENTRANCE_MARKER = /(东门|西门|南门|北门|正门|侧门|入口|出口)$/u;
const LEGACY_SUBPLACE_PATTERNS = [
    {
        pattern: /^(.+?)(综合门诊楼|门诊综合楼|门诊大楼|门诊楼|门诊大厅|诊疗楼|住院大楼|住院楼|住院部|急诊楼|急诊部|教学楼|办公楼|航站楼|候机楼)$/u,
        kind: 'building',
    },
    {
        pattern: /^(.+?)([A-Za-zＡ-Ｚａ-ｚ0-9一二三四五六七八九十]+(?:号楼|栋|座))$/u,
        kind: 'building',
    },
    {
        pattern: /^(.+?)(东门|西门|南门|北门|正门|侧门|入口|出口)$/u,
        kind: 'entrance',
    },
    {
        pattern: /^(.+(?:医院|大学|学校|公司|景区|中心))(.{1,6}(?:院区|校区|园区|分院|分部|本部))$/u,
        kind: 'campus',
    },
];
const SUBPLACE_SYNONYMS = new Map([
    ['门诊楼', ['门诊楼', '门诊部', '门诊大厅', '综合门诊楼', '门诊综合楼', '诊疗楼']],
    ['门诊大楼', ['门诊大楼', '门诊楼', '综合门诊楼', '门诊综合楼', '门诊大厅', '诊疗楼']],
    ['综合门诊楼', ['综合门诊楼', '门诊综合楼', '门诊楼', '门诊大厅', '诊疗楼']],
    ['门诊综合楼', ['门诊综合楼', '综合门诊楼', '门诊楼', '门诊大厅', '诊疗楼']],
    ['住院部', ['住院部', '住院楼', '住院大楼']],
    ['住院楼', ['住院楼', '住院部', '住院大楼']],
    ['急诊楼', ['急诊楼', '急诊部', '急诊中心']],
    ['急诊部', ['急诊部', '急诊楼', '急诊中心']],
]);

function normalizeText(value) {
    return String(value ?? '')
        .toLocaleLowerCase()
        .replace(/\s+/g, '')
        .replace(/[()（）[\]【】·•,，.。\-_/\\]/g, '');
}

function getPoiLocation(poi) {
    const location = poi?.location;
    if (!location) return null;
    let lng;
    let lat;
    if (typeof location === 'string') {
        [lng, lat] = location.split(',', 2).map(Number);
    } else if (Array.isArray(location)) {
        [lng, lat] = location.map(Number);
    } else {
        lng = Number(typeof location.getLng === 'function' ? location.getLng() : location.lng);
        lat = Number(typeof location.getLat === 'function' ? location.getLat() : location.lat);
    }
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

function getPoiId(poi) {
    const id = poi?.id ?? poi?.poiId ?? poi?.poiid;
    return typeof id === 'string' || typeof id === 'number' ? String(id) : '';
}

function collectParentIds(value, result = new Set()) {
    if (typeof value === 'string' || typeof value === 'number') {
        const id = String(value).trim();
        if (id) result.add(id);
        return result;
    }
    if (Array.isArray(value)) {
        value.forEach(item => collectParentIds(item, result));
        return result;
    }
    if (value && typeof value === 'object') {
        collectParentIds(value.id ?? value.poiId ?? value.parentId ?? value.cpid, result);
    }
    return result;
}

function getPoiParentIds(poi) {
    const result = new Set();
    collectParentIds(poi?.parent, result);
    collectParentIds(poi?.parentId, result);
    collectParentIds(poi?.parentid, result);
    collectParentIds(poi?.indoor_data?.cpid, result);
    return result;
}

function getChildPois(poi) {
    const values = [
        poi?.children,
        poi?.subPois,
        poi?.subpois,
        poi?.childPois,
        poi?.childpois,
    ];
    const result = [];
    for (const value of values) {
        if (Array.isArray(value)) {
            result.push(...value);
        } else if (Array.isArray(value?.pois)) {
            result.push(...value.pois);
        } else if (Array.isArray(value?.children)) {
            result.push(...value.children);
        }
    }
    return result;
}

function flattenPoiHierarchy(pois) {
    const result = [];
    const visited = new Set();
    const visit = (poi, inheritedParentId = '') => {
        if (!poi || typeof poi !== 'object') return;
        const key = candidateKey(poi);
        const visitKey = `${key}|${inheritedParentId}`;
        if (visited.has(visitKey)) return;
        visited.add(visitKey);

        const parentIds = getPoiParentIds(poi);
        if (inheritedParentId) parentIds.add(inheritedParentId);
        result.push({ poi, parentIds });

        const poiId = getPoiId(poi) || inheritedParentId;
        getChildPois(poi).forEach(child => visit(child, poiId));
    };
    (Array.isArray(pois) ? pois : []).forEach(poi => visit(poi));
    return result;
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

function runPlaceSearch(searcher, method, args, timeoutMs = 0, signal = null) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve([]);
            return;
        }
        let settled = false;
        let timer = null;
        const onAbort = () => finish([]);
        const finish = (pois) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(pois);
        };
        const callback = (status, result) => {
            finish(status === 'complete' && Array.isArray(result?.poiList?.pois)
                ? result.poiList.pois
                : []);
        };
        if (timeoutMs > 0) {
            timer = setTimeout(() => finish([]), timeoutMs);
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            searcher[method](...args, callback);
        } catch (_) {
            finish([]);
        }
    });
}

function stringField(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function inferCity(fullName) {
    const text = String(fullName).trim();
    const municipality = text.match(/^(北京市|上海市|天津市|重庆市)/u);
    if (municipality) return municipality[1];
    const afterProvince = text.match(/(?:省|自治区)([^省自治区]{2,12}?(?:市|自治州|地区))/u);
    if (afterProvince) return afterProvince[1];
    const direct = text.match(/^([^省自治区]{2,12}?(?:市|自治州|地区))/u);
    return direct?.[1] || '';
}

function normalizeCity(value) {
    const city = String(value ?? '').trim();
    if (!city || /^\d{6}$/u.test(city)) return city;
    return inferCity(city) || city;
}

function inferSubplace(fullName) {
    const normalized = String(fullName).trim();
    for (const entry of LEGACY_SUBPLACE_PATTERNS) {
        const match = normalized.match(entry.pattern);
        if (!match) continue;
        const parent = match[1].replace(/的$/u, '').trim();
        const subplace = match[2].trim();
        if (parent && subplace) {
            return { parent, subplace, kind: entry.kind };
        }
    }
    return { parent: '', subplace: '', kind: 'unknown' };
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getNarrativePlaceAliases(placeName) {
    const name = String(placeName ?? '').replace(/\s+/g, '').trim();
    if (!name) return [];
    const aliases = new Set([name]);
    const city = inferCity(name);
    const cityIndex = city ? name.indexOf(city) : -1;
    if (cityIndex >= 0) {
        const withoutCity = name.slice(cityIndex + city.length);
        if (withoutCity.length >= 4) aliases.add(withoutCity);
    }
    return [...aliases].sort((a, b) => b.length - a.length);
}

function findQualifiedCampus(placeName, narrativeTexts) {
    const aliases = getNarrativePlaceAliases(placeName);
    for (const rawText of narrativeTexts) {
        const text = String(rawText ?? '').replace(/\s+/g, '');
        if (!text) continue;
        const matches = new Set();
        let latestPlaceIndex = -1;
        let latestCampusPlaceIndex = -1;
        for (const alias of aliases) {
            let aliasIndex = text.indexOf(alias);
            while (aliasIndex >= 0) {
                latestPlaceIndex = Math.max(latestPlaceIndex, aliasIndex);
                aliasIndex = text.indexOf(alias, aliasIndex + alias.length);
            }
            const pattern = new RegExp(
                `${escapeRegExp(alias)}(?:的)?[（(]?([\\p{Script=Han}A-Za-z0-9]{1,12}(?:院区|校区|园区|分院|分部|本部))[）)]?`,
                'gu',
            );
            for (const match of text.matchAll(pattern)) {
                const campus = match[1];
                if (/(位于|目前|正在|来到|进入|抵达|前往|离开|返回|内的|user|用户|角色|这里)/iu.test(campus)) {
                    continue;
                }
                matches.add(campus);
                latestCampusPlaceIndex = Math.max(latestCampusPlaceIndex, match.index);
            }
        }
        if (latestPlaceIndex > latestCampusPlaceIndex) return '';
        if (matches.size === 1) return [...matches][0];
        if (matches.size > 1) return '';
    }
    return '';
}

/**
 * 将新版结构化地点或旧版字符串统一为剧情地点意图。
 * @param {string|object} value LLM 输出的地点字段
 * @returns {{full:string, city:string, parent:string, subplace:string, kind:string, hierarchical:boolean}}
 */
export function normalizePlaceIntent(value) {
    if (typeof value === 'string') {
        const full = value.trim();
        if (!full) {
            return { full: '', city: '', parent: '', subplace: '', kind: 'unknown', hierarchical: false };
        }
        const inferred = inferSubplace(full);
        return {
            full,
            city: inferCity(full),
            parent: inferred.parent,
            subplace: inferred.subplace,
            kind: inferred.kind,
            hierarchical: Boolean(inferred.parent && inferred.subplace),
        };
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { full: '', city: '', parent: '', subplace: '', kind: 'unknown', hierarchical: false };
    }

    let full = stringField(value.full ?? value.full_name ?? value.name);
    let city = normalizeCity(stringField(value.city ?? value.administrative_area));
    let parent = stringField(value.parent ?? value.parent_name);
    let subplace = stringField(value.subplace ?? value.sub_place ?? value.child);
    let kind = stringField(value.kind ?? value.place_kind);

    if (!full && (parent || subplace)) {
        full = `${parent}${subplace}`;
    }
    if (!city && full) {
        city = normalizeCity(full);
    }
    if (!parent && subplace && full.endsWith(subplace)) {
        parent = full.slice(0, -subplace.length).replace(/的$/u, '').trim();
    }
    if ((!parent || !subplace) && full) {
        const inferred = inferSubplace(full);
        parent ||= inferred.parent;
        subplace ||= inferred.subplace;
        if (!kind || kind === 'unknown') kind = inferred.kind;
    }
    if (!NARRATIVE_PLACE_KINDS.has(kind) || kind === 'unknown') {
        if (subplace && BUILDING_MARKER.test(subplace)) {
            kind = 'building';
        } else if (subplace && ENTRANCE_MARKER.test(subplace)) {
            kind = 'entrance';
        } else if (subplace && CAMPUS_MARKER.test(subplace)) {
            kind = 'campus';
        } else if (subplace && DEPARTMENT_MARKER.test(subplace)) {
            kind = 'department';
        } else {
            kind = 'unknown';
        }
    }

    return {
        full,
        city,
        parent,
        subplace,
        kind,
        hierarchical: Boolean(parent && subplace),
    };
}

/**
 * 当LLM遗漏院区或校区限定词时，从本轮剧情中的明确完整地名恢复层级。
 * 仅在单段剧情内只出现一个与父场所绑定的限定词时纠偏。
 */
export function refinePlaceIntentFromNarrative(value, narrativeTexts = []) {
    const intent = normalizePlaceIntent(value);
    if (!intent.full) return intent;
    if ([intent.full, intent.parent, intent.subplace]
        .some(part => CAMPUS_MARKER.test(normalizeText(part)))) {
        return intent;
    }

    const basePlace = intent.parent || intent.full;
    const campus = findQualifiedCampus(basePlace, Array.isArray(narrativeTexts)
        ? narrativeTexts
        : [narrativeTexts]);
    if (!campus) return intent;

    if (intent.subplace) {
        const campusParent = `${basePlace}${campus}`;
        return {
            ...intent,
            full: `${campusParent}${intent.subplace}`,
            parent: campusParent,
            hierarchical: true,
        };
    }
    return {
        ...intent,
        full: `${basePlace}${campus}`,
        parent: basePlace,
        subplace: campus,
        kind: 'campus',
        hierarchical: true,
    };
}

function getSubplaceVariants(intent) {
    const normalizedSubplace = normalizeText(intent.subplace);
    for (const [key, variants] of SUBPLACE_SYNONYMS.entries()) {
        if (normalizeText(key) === normalizedSubplace) {
            return [...new Set(variants)];
        }
    }
    return intent.subplace ? [intent.subplace] : [];
}

function administrativeContextMatches(poi, city) {
    const normalizedCity = normalizeText(city);
    if (!normalizedCity) return true;
    const shortCity = normalizedCity.replace(/(特别行政区|自治州|地区|市)$/u, '');
    const fields = [poi?.pname, poi?.cityname, poi?.adname, poi?.address]
        .map(normalizeText)
        .filter(Boolean);
    if (!fields.length) return true;
    return fields.some(field => field.includes(normalizedCity)
        || (shortCity.length >= 2 && field.includes(shortCity)));
}

function getParentMatchLevel(poi, parentName) {
    const name = normalizeText(poi?.name);
    const parent = normalizeText(parentName);
    if (!name || !parent) return 0;
    if (name === parent) return 3;
    if (name.startsWith(parent)) {
        const suffix = name.slice(parent.length);
        if (CAMPUS_MARKER.test(suffix)) return 2;
        if (DEPARTMENT_MARKER.test(suffix) || BUILDING_MARKER.test(suffix)) return 0;
    }
    if (parent.startsWith(name) && CAMPUS_MARKER.test(parent.slice(name.length))) return 1;
    return 0;
}

function chooseParentCandidate(AMap, entries, parentName, city, origin) {
    const explicitCampus = CAMPUS_MARKER.test(normalizeText(parentName));
    const candidates = entries
        .map((entry, index) => ({
            ...entry,
            index,
            matchLevel: getParentMatchLevel(entry.poi, parentName),
            originDistance: calculateDistance(AMap, entry.poi, origin),
        }))
        .filter(entry => entry.matchLevel > 0
            && (!explicitCampus || entry.matchLevel === 3)
            && administrativeContextMatches(entry.poi, city)
            && getPoiLocation(entry.poi));
    if (!candidates.length) return null;

    const hasOrigin = origin && Number.isFinite(origin.lng) && Number.isFinite(origin.lat);
    candidates.sort((a, b) => {
        if (explicitCampus && a.matchLevel !== b.matchLevel) {
            return b.matchLevel - a.matchLevel;
        }
        if (hasOrigin && a.originDistance !== b.originDistance) {
            return a.originDistance - b.originDistance;
        }
        if (a.matchLevel !== b.matchLevel) return b.matchLevel - a.matchLevel;
        return a.index - b.index;
    });
    return candidates[0];
}

function isBuildingCandidateCompatible(poi, exactOrSynonymMatch, targetSubplace = '') {
    const name = String(poi?.name ?? '');
    const hasBuildingMarker = BUILDING_MARKER.test(name);
    const targetIsDepartment = DEPARTMENT_MARKER.test(String(targetSubplace));
    if (DEPARTMENT_MARKER.test(name) && !targetIsDepartment) return false;
    return exactOrSynonymMatch || hasBuildingMarker;
}

function isBuildingSemanticCompatible(name, subplace) {
    const candidate = normalizeText(name);
    const target = normalizeText(subplace);
    if (/门诊/u.test(target)) return /(门诊|诊疗|综合)/u.test(candidate);
    if (/住院/u.test(target)) return /(住院|病房|综合)/u.test(candidate);
    if (/急诊|急救/u.test(target)) return /(急诊|急救|综合)/u.test(candidate);
    return true;
}

function candidateParentTextMatches(poi, parentName) {
    const parent = normalizeText(parentName);
    if (!parent) return false;
    return normalizeText(getCandidateText(poi)).includes(parent);
}

function mergeNarrativeEntries(groups) {
    const merged = new Map();
    for (const group of groups) {
        for (const entry of group) {
            if (!getPoiLocation(entry.poi)) continue;
            const key = candidateKey(entry.poi);
            const existing = merged.get(key);
            if (existing) {
                entry.parentIds.forEach(id => existing.parentIds.add(id));
            } else {
                merged.set(key, {
                    poi: entry.poi,
                    parentIds: new Set(entry.parentIds),
                    index: merged.size,
                });
            }
        }
    }
    return [...merged.values()];
}

function getNarrativeCandidateRank(AMap, entry, intent, parentEntry, variants) {
    const poi = entry.poi;
    if (!administrativeContextMatches(poi, intent.city)) return null;

    const name = normalizeText(poi?.name);
    const full = normalizeText(intent.full);
    const subplace = normalizeText(intent.subplace);
    const normalizedVariants = variants.map(normalizeText);
    const fullExact = Boolean(full && name === full);
    const childExact = Boolean(subplace && name.includes(subplace));
    const childSynonym = normalizedVariants.some(variant => variant && name.includes(variant));
    const exactOrSynonym = childExact || childSynonym;
    if (intent.kind === 'building'
        && !isBuildingCandidateCompatible(poi, exactOrSynonym, intent.subplace)) {
        return null;
    }

    const parentPoi = parentEntry?.poi;
    const parentId = getPoiId(parentPoi);
    const parentIdMatch = Boolean(parentId && entry.parentIds.has(parentId));
    const parentTextMatch = candidateParentTextMatches(poi, intent.parent);
    const parentDistance = calculateDistance(AMap, poi, getPoiLocation(parentPoi));
    const exactChildByProximity = childExact && parentDistance <= NARRATIVE_PARENT_PROXIMITY_METERS;
    const strongParentMatch = parentIdMatch || parentTextMatch;

    let tier = Infinity;
    let strategy = '';
    let confidence = 'low';
    if (fullExact) {
        tier = 1;
        strategy = 'exact-full';
        confidence = 'high';
    } else if (childExact && (strongParentMatch || exactChildByProximity)) {
        tier = 2;
        strategy = 'exact-child';
        confidence = 'high';
    } else if (childSynonym && strongParentMatch) {
        tier = 3;
        strategy = 'synonym-child';
        confidence = 'medium';
    } else if (intent.kind === 'building'
        && isBuildingCandidateCompatible(poi, false, intent.subplace)
        && isBuildingSemanticCompatible(poi?.name, intent.subplace)
        && strongParentMatch
        && parentDistance <= NARRATIVE_NEARBY_RADIUS_METERS) {
        tier = 4;
        strategy = 'nearest-compatible-building';
        confidence = 'medium';
    }
    if (!Number.isFinite(tier)) return null;

    return {
        ...entry,
        tier,
        strategy,
        confidence,
        parentDistance,
    };
}

function createNarrativeSearcher(AMap, city) {
    return new AMap.PlaceSearch({
        city: city || '全国',
        citylimit: Boolean(city),
        children: 1,
        extensions: 'all',
        pageSize: 50,
        pageIndex: 1,
    });
}

function toNarrativeResolution(intent, selected, parentEntry) {
    const location = getPoiLocation(selected.poi);
    if (!location) return null;
    return {
        ...location,
        label: intent.full || String(selected.poi?.name ?? ''),
        poi: selected.poi,
        parentPoi: parentEntry?.poi || null,
        parentPoiId: getPoiId(parentEntry?.poi) || [...(selected.parentIds || [])][0] || '',
        strategy: selected.strategy,
        confidence: selected.confidence,
        intent,
    };
}

/**
 * 剧情专用父子地点解析。该函数不改变手动搜索使用的 searchRankedPlaces。
 * @param {object} AMap 高德 JS API
 * @param {string|object} placeInput LLM 地点字段
 * @param {object} options 解析选项
 * @returns {Promise<object|null>} 解析结果
 */
export async function resolveNarrativePlace(AMap, placeInput, {
    origin = null,
    timeoutMs = NARRATIVE_SEARCH_TIMEOUT_MS,
    signal = null,
} = {}) {
    const intent = normalizePlaceIntent(placeInput);
    if (!intent.full || !AMap?.PlaceSearch || signal?.aborted) return null;

    const parentName = intent.parent || intent.full;
    const queries = [...new Set([intent.full, parentName].filter(Boolean))];
    const baseSettled = await Promise.allSettled(queries.map((query) => {
        const searcher = createNarrativeSearcher(AMap, intent.city);
        return runPlaceSearch(searcher, 'search', [query], timeoutMs, signal);
    }));
    if (signal?.aborted) return null;
    const baseGroups = baseSettled
        .filter(result => result.status === 'fulfilled')
        .map(result => flattenPoiHierarchy(result.value));
    const baseEntries = mergeNarrativeEntries(baseGroups);
    const parentEntry = chooseParentCandidate(AMap, baseEntries, parentName, intent.city, origin);

    const exactFullCandidates = baseEntries
        .filter(entry => normalizeText(entry.poi?.name) === normalizeText(intent.full)
            && administrativeContextMatches(entry.poi, intent.city)
            && (intent.kind !== 'building'
                || isBuildingCandidateCompatible(entry.poi, true, intent.subplace)))
        .map((entry, index) => ({
            ...entry,
            index,
            originDistance: calculateDistance(AMap, entry.poi, origin),
        }))
        .sort((a, b) => a.originDistance - b.originDistance || a.index - b.index);
    if (exactFullCandidates.length) {
        const exactCandidate = exactFullCandidates[0];
        const linkedParent = [...exactCandidate.parentIds]
            .map(parentId => baseEntries.find(entry => getPoiId(entry.poi) === parentId))
            .find(Boolean);
        const exactParent = linkedParent
            || (exactCandidate.parentIds.size ? null : parentEntry);
        return toNarrativeResolution(intent, {
            ...exactCandidate,
            strategy: 'exact-full',
            confidence: 'high',
        }, exactParent);
    }

    if (!parentEntry) return null;

    if (!intent.subplace) {
        return toNarrativeResolution(intent, {
            ...parentEntry,
            strategy: 'exact-parent',
            confidence: parentEntry.matchLevel >= 2 ? 'high' : 'medium',
        }, parentEntry);
    }

    const parentLocation = getPoiLocation(parentEntry.poi);
    const variants = getSubplaceVariants(intent);
    const nearbySettled = parentLocation
        ? await Promise.allSettled(variants.map((variant) => {
            const searcher = createNarrativeSearcher(AMap, intent.city);
            return runPlaceSearch(searcher, 'searchNearBy', [
                variant,
                [parentLocation.lng, parentLocation.lat],
                NARRATIVE_NEARBY_RADIUS_METERS,
            ], timeoutMs, signal);
        }))
        : [];
    if (signal?.aborted) return null;
    const nearbyGroups = nearbySettled
        .filter(result => result.status === 'fulfilled')
        .map(result => flattenPoiHierarchy(result.value));
    const allEntries = mergeNarrativeEntries([...baseGroups, ...nearbyGroups]);
    const parentKey = candidateKey(parentEntry.poi);
    const ranked = allEntries
        .filter(entry => candidateKey(entry.poi) !== parentKey)
        .map(entry => getNarrativeCandidateRank(AMap, entry, intent, parentEntry, variants))
        .filter(Boolean)
        .sort((a, b) => {
            if (a.tier !== b.tier) return a.tier - b.tier;
            if (a.parentDistance !== b.parentDistance) return a.parentDistance - b.parentDistance;
            return a.index - b.index;
        });

    if (ranked.length) {
        return toNarrativeResolution(intent, ranked[0], parentEntry);
    }
    const explicitCampusTarget = CAMPUS_MARKER.test(normalizeText(intent.subplace))
        || (!intent.subplace && CAMPUS_MARKER.test(normalizeText(intent.full)));
    if (explicitCampusTarget) {
        return null;
    }
    return toNarrativeResolution(intent, {
        ...parentEntry,
        strategy: 'parent-fallback',
        confidence: 'low',
    }, parentEntry);
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
    signal = null,
} = {}) {
    const normalizedQuery = String(query ?? '').trim();
    if (!normalizedQuery || !AMap?.PlaceSearch || signal?.aborted) return [];

    const nationalSearcher = new AMap.PlaceSearch({
        city,
        citylimit: false,
        pageSize,
        pageIndex: 1,
    });
    const tasks = [{
        source: 'national',
        promise: runPlaceSearch(nationalSearcher, 'search', [normalizedQuery], 0, signal),
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
            ], 0, signal),
        });
    }

    const settled = await Promise.allSettled(tasks.map(task => task.promise));
    if (signal?.aborted) return [];
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
