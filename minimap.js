import { loadAmap } from './amap.js';
import { ensureBaseSettings, findLastAiMessage, getChatState, saveWindowPos, loadWindowPos } from './state.js';
import { openFullscreen } from './fullscreen.js';

const WIDGET_ID = 'realmap_minimap';
const DEFAULT_W = 320;
const DEFAULT_H = 180;
const DEFAULT_INSET = 16;

let mapInstance = null;
let mapContainer = null;
let disabledByUser = false;

export function isMinimapVisible() {
    return $(`#${WIDGET_ID}`).is(':visible');
}

export function hideMinimap() {
    $(`#${WIDGET_ID}`).hide();
}

export function showMinimap() {
    $(`#${WIDGET_ID}`).show();
    if (mapInstance) {
        try { mapInstance.setStatus('show'); } catch (_) {}
    }
    refreshMap();
}

function applySavedPosition($w) {
    const pos = loadWindowPos();
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
        $w.css({ left: pos.x + 'px', top: pos.y + 'px', width: pos.w + 'px', height: pos.h + 'px', margin: 'unset' });
    } else {
        const x = Math.max(0, window.innerWidth - DEFAULT_W - DEFAULT_INSET);
        const y = Math.max(0, window.innerHeight - DEFAULT_H - DEFAULT_INSET);
        $w.css({ left: x + 'px', top: y + 'px', width: DEFAULT_W + 'px', height: DEFAULT_H + 'px', margin: 'unset' });
    }
}

function bindDragEnd($w) {
    $w.on('mouseup', () => {
        setTimeout(() => {
            const left = parseInt($w.css('left')) || 0;
            const top = parseInt($w.css('top')) || 0;
            const w = parseInt($w.css('width')) || DEFAULT_W;
            const h = parseInt($w.css('height')) || DEFAULT_H;
            saveWindowPos(left, top, w, h);
        }, 0);
    });
}

async function ensureMap() {
    if (mapInstance) return mapInstance;
    const s = ensureBaseSettings();
    const AMap = await loadAmap(s.key, s.securityCode);
    mapContainer = document.getElementById('realmap_map_container');
    if (!mapContainer) return null;
    mapInstance = new AMap.Map(mapContainer, {
        zoom: 12,
        scrollWheel: false,
        dragEnable: false,
        doubleClickZoom: false,
        keyboardEnable: false,
    });
    return mapInstance;
}

export async function refreshMap() {
    const state = getChatState();
    if (!state) {
        $('#realmap_clean_state_hint').show();
        return;
    }
    $('#realmap_clean_state_hint').hide();
    try {
        const m = await ensureMap();
        if (!m) return;
        await renderStateOnMap(m, state);
    } catch (e) {
        console.error('[realmap] refresh map failed', e);
    }
}

async function renderStateOnMap(map, state) {
    map.clearMap();
    const AMap = window.AMap;
    if (!AMap) return;
    if (state.mode === 'idle' && typeof state.lng === 'number' && typeof state.lat === 'number') {
        const marker = new AMap.Marker({
            position: [state.lng, state.lat],
            icon: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png',
        });
        map.add(marker);
        map.setCenter([state.lng, state.lat]);
    } else if (state.mode === 'moving' && state.from && state.to) {
        const fromM = new AMap.Marker({ position: [state.from.lng, state.from.lat], icon: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_b.png' });
        const toM = new AMap.Marker({ position: [state.to.lng, state.to.lat], icon: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_y.png' });
        map.add([fromM, toM]);
        if (Array.isArray(state.polyline) && state.polyline.length) {
            const poly = new AMap.Polyline({ path: state.polyline, strokeColor: '#00b0ff', strokeWeight: 3, strokeStyle: 'dashed' });
            map.add(poly);
            map.setFitView([poly]);
        } else {
            map.setFitView([fromM, toM]);
        }
    }
}

function bindZoom() {
    $('#realmap_zoom_in').on('click', async () => {
        try {
            const m = await ensureMap();
            m.zoomIn();
        } catch (e) { console.warn(e); }
    });
    $('#realmap_zoom_out').on('click', async () => {
        try {
            const m = await ensureMap();
            m.zoomOut();
        } catch (e) { console.warn(e); }
    });
}

function bindFullscreenToggle() {
    $('#realmap_map_container').on('click', async (e) => {
        if (e.target.closest('#realmap_zoom_in') || e.target.closest('#realmap_zoom_out')) return;
        try {
            await openFullscreen({ getState: getChatState, refreshMinimap: refreshMap });
        } catch (err) {
            console.error('[realmap] open fullscreen failed', err);
        }
    });
}

export async function initMinimap({ onDisableClick }) {
    const $w = $(`#${WIDGET_ID}`);
    if (!$w.length) return;
    applySavedPosition($w);
    bindZoom();
    bindFullscreenToggle();
    bindDragEnd($w);
    $('#realmap_disable_btn').on('click', () => { if (onDisableClick) onDisableClick(); });
    $('#realmap_minimap_close').on('click', () => hideMinimap());
    await ensureMap();
    refreshMap();
}
