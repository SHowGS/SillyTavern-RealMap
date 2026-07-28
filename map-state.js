const ROUTE_BLUE = '#1677ff';

function normalizeCoordinate(value) {
    if (Array.isArray(value)) {
        const lng = Number(value[0]);
        const lat = Number(value[1]);
        return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
    }
    if (value && typeof value === 'object') {
        const lng = typeof value.getLng === 'function' ? Number(value.getLng()) : Number(value.lng);
        const lat = typeof value.getLat === 'function' ? Number(value.getLat()) : Number(value.lat);
        return Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
    }
    return null;
}

export function normalizeRoutePath(polyline) {
    if (!Array.isArray(polyline)) return [];
    return polyline.map(normalizeCoordinate).filter(Boolean);
}

export function projectPointToRoute(point, polyline) {
    const origin = normalizeCoordinate(point);
    const path = normalizeRoutePath(polyline);
    if (!origin || !path.length) return null;
    if (path.length === 1) return path[0];

    const longitudeScale = Math.max(0.01, Math.cos(origin.lat * Math.PI / 180));
    let best = null;
    let bestDistanceSquared = Number.POSITIVE_INFINITY;

    for (let index = 1; index < path.length; index++) {
        const start = path[index - 1];
        const end = path[index];
        const segmentX = (end.lng - start.lng) * longitudeScale;
        const segmentY = end.lat - start.lat;
        const pointX = (origin.lng - start.lng) * longitudeScale;
        const pointY = origin.lat - start.lat;
        const segmentLengthSquared = segmentX * segmentX + segmentY * segmentY;
        const ratio = segmentLengthSquared > 0
            ? Math.max(0, Math.min(1, (pointX * segmentX + pointY * segmentY) / segmentLengthSquared))
            : 0;
        const lng = start.lng + (end.lng - start.lng) * ratio;
        const lat = start.lat + (end.lat - start.lat) * ratio;
        const distanceX = (origin.lng - lng) * longitudeScale;
        const distanceY = origin.lat - lat;
        const distanceSquared = distanceX * distanceX + distanceY * distanceY;

        if (distanceSquared < bestDistanceSquared) {
            bestDistanceSquared = distanceSquared;
            best = { lng, lat };
        }
    }

    return best;
}

export function getMovingRoutePosition(state) {
    if (!state?.from) return null;
    return projectPointToRoute(state.from, state.polyline) || normalizeCoordinate(state.from);
}

function normalizePlaceLabel(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .replace(/[\s,，。.;；:：()（）[\]【】"'“”‘’]/gu, '')
        .toLowerCase();
}

export function placeLabelsReferToSameLocation(first, second) {
    const left = normalizePlaceLabel(first);
    const right = normalizePlaceLabel(second);
    if (!left || !right) return false;
    if (left === right) return true;
    return Math.min(left.length, right.length) >= 4
        && (left.includes(right) || right.includes(left));
}

function routeSegmentLength(first, second) {
    const averageLat = (first.lat + second.lat) / 2;
    const longitudeScale = Math.cos(averageLat * Math.PI / 180);
    const dx = (second.lng - first.lng) * longitudeScale;
    const dy = second.lat - first.lat;
    return Math.sqrt(dx * dx + dy * dy);
}

export function getPointAlongRoute(polyline, progressRatio) {
    const path = normalizeRoutePath(polyline);
    if (!path.length) return null;
    if (path.length === 1) return path[0];

    const ratio = Math.max(0, Math.min(1, Number(progressRatio) || 0));
    const segments = [];
    let totalLength = 0;
    for (let index = 1; index < path.length; index++) {
        const length = routeSegmentLength(path[index - 1], path[index]);
        segments.push(length);
        totalLength += length;
    }
    if (totalLength <= 0) return path[0];

    const targetLength = totalLength * ratio;
    let traversed = 0;
    for (let index = 1; index < path.length; index++) {
        const segmentLength = segments[index - 1];
        if (traversed + segmentLength >= targetLength) {
            const localRatio = segmentLength > 0
                ? (targetLength - traversed) / segmentLength
                : 0;
            return {
                lng: path[index - 1].lng
                    + (path[index].lng - path[index - 1].lng) * localRatio,
                lat: path[index - 1].lat
                    + (path[index].lat - path[index - 1].lat) * localRatio,
            };
        }
        traversed += segmentLength;
    }
    return path[path.length - 1];
}

export function getMovingProgress(elapsedMin, totalDurationMin, maxProgress = 0.98) {
    const elapsed = Number(elapsedMin);
    const total = Number(totalDurationMin);
    if (!Number.isFinite(elapsed) || elapsed <= 0
        || !Number.isFinite(total) || total <= 0) {
        return 0;
    }
    return Math.min(Math.max(0, maxProgress), elapsed / total);
}

function coordinatesEqual(first, second) {
    return Math.abs(first.lng - second.lng) < 1e-12
        && Math.abs(first.lat - second.lat) < 1e-12;
}

export function splitRouteAtProgress(polyline, progressRatio) {
    const path = normalizeRoutePath(polyline);
    if (path.length < 2) return { traveled: [], remaining: path };

    const ratio = Math.max(0, Math.min(1, Number(progressRatio) || 0));
    if (ratio <= 0) return { traveled: [], remaining: path };
    if (ratio >= 1) return { traveled: path, remaining: [] };

    const segmentLengths = [];
    let totalLength = 0;
    for (let index = 1; index < path.length; index++) {
        const length = routeSegmentLength(path[index - 1], path[index]);
        segmentLengths.push(length);
        totalLength += length;
    }
    if (totalLength <= 0) return { traveled: [], remaining: path };

    const targetLength = totalLength * ratio;
    const traveled = [path[0]];
    let traversedLength = 0;

    for (let index = 1; index < path.length; index++) {
        const segmentLength = segmentLengths[index - 1];
        if (traversedLength + segmentLength >= targetLength) {
            const localRatio = segmentLength > 0
                ? (targetLength - traversedLength) / segmentLength
                : 0;
            const splitPoint = {
                lng: path[index - 1].lng
                    + (path[index].lng - path[index - 1].lng) * localRatio,
                lat: path[index - 1].lat
                    + (path[index].lat - path[index - 1].lat) * localRatio,
            };
            if (!coordinatesEqual(traveled[traveled.length - 1], splitPoint)) {
                traveled.push(splitPoint);
            }
            const remaining = [splitPoint];
            if (!coordinatesEqual(splitPoint, path[index])) remaining.push(path[index]);
            remaining.push(...path.slice(index + 1));
            return { traveled, remaining };
        }
        traveled.push(path[index]);
        traversedLength += segmentLength;
    }

    return { traveled: path, remaining: [] };
}

function toAmapPath(path) {
    return path.map(({ lng, lat }) => [lng, lat]);
}

export function addAmapRoutePolyline(
    map,
    AMap,
    polyline,
    { zIndex = 50, progressRatio = 0 } = {},
) {
    const path = normalizeRoutePath(polyline);
    if (!map || !AMap?.Polyline || path.length < 2) return [];

    const border = new AMap.Polyline({
        path: toAmapPath(path),
        strokeColor: '#ffffff',
        strokeWeight: 12,
        strokeOpacity: 1,
        strokeStyle: 'solid',
        lineJoin: 'round',
        lineCap: 'round',
        zIndex,
    });
    const { traveled, remaining } = splitRouteAtProgress(path, progressRatio);
    const overlays = [border];

    if (traveled.length >= 2) {
        overlays.push(new AMap.Polyline({
            path: toAmapPath(traveled),
            strokeColor: '#9aa0a6',
            strokeWeight: 8,
            strokeOpacity: 1,
            strokeStyle: 'solid',
            lineJoin: 'round',
            lineCap: 'round',
            zIndex: zIndex + 1,
        }));
    }
    if (remaining.length >= 2) {
        overlays.push(new AMap.Polyline({
            path: toAmapPath(remaining),
            strokeColor: ROUTE_BLUE,
            strokeWeight: 8,
            strokeOpacity: 1,
            strokeStyle: 'solid',
            lineJoin: 'round',
            lineCap: 'round',
            showDir: true,
            dirColor: '#ffffff',
            zIndex: zIndex + 2,
        }));
    }

    map.add(overlays);
    return overlays;
}

const AMAP_RED_MARKER_URL = 'https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png';
const DESTINATION_MARKER_CONTENT = `
<img
  src="${AMAP_RED_MARKER_URL}"
  alt="destination"
  style="display:block;width:19px;height:33px;filter:hue-rotate(60deg) saturate(1.35) brightness(1.12);"
/>`;

export function createAmapDestinationMarker(AMap, position, { extData = undefined } = {}) {
    const point = normalizeCoordinate(position);
    if (!AMap?.Marker || !point) return null;
    return new AMap.Marker({
        position: [point.lng, point.lat],
        content: DESTINATION_MARKER_CONTENT,
        anchor: 'bottom-center',
        zIndex: 120,
        ...(extData === undefined ? {} : { extData }),
    });
}

export function fitMovingMapView(map, overlays, fallbackPosition, padding = [36, 36, 36, 36]) {
    const visibleOverlays = Array.isArray(overlays) ? overlays.filter(Boolean) : [];
    if (visibleOverlays.length >= 2 && typeof map?.setFitView === 'function') {
        map.setFitView(visibleOverlays, false, padding, 18);
        return;
    }
    const fallback = normalizeCoordinate(fallbackPosition);
    if (fallback && typeof map?.setCenter === 'function') {
        map.setCenter([fallback.lng, fallback.lat]);
    }
}
