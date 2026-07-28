import { loadAmap } from './amap.js';
import {
    ensureBaseSettings,
    findLastAiMessage,
    getChatState,
    saveWindowPos,
    loadWindowPos,
    getCurrentPosition,
    isExtensionEnabledForChat,
} from './state.js';
import { openFullscreen } from './fullscreen.js';
import { createLayerController } from './layer-control.js';
import { isMobile } from '../../../RossAscends-mods.js';
import {
    addAmapRoutePolyline,
    createAmapDestinationMarker,
    fitMovingMapView,
    getMovingRoutePosition,
} from './map-state.js';

const WIDGET_ID = 'realmap_minimap';
const DEFAULT_W = 320;
const DEFAULT_H = 240;
const DEFAULT_INSET = 16;

let mapInstance = null;
let mapContainer = null;
let disabledByUser = false;
let layerController = null;
let _onDisableClick = null;
let _onRejudge = null;
let floatingBallEl = null;
let ballFocused = true;
let ballDefocusTimer = null;

export function isMinimapVisible() {
    if (isMobile()) return floatingBallEl && floatingBallEl.style.display !== 'none';
    return $(`#${WIDGET_ID}`).is(':visible');
}

export function hideMinimap() {
    if (isMobile()) { hideFloatingBall(); return; }
    $(`#${WIDGET_ID}`).hide();
}

export function showMinimap() {
    if (!isExtensionEnabledForChat()) {
        hideMinimap();
        return;
    }
    if (isMobile()) { showFloatingBall(); return; }
    $(`#${WIDGET_ID}`).show();
    if (mapInstance) {
        try { mapInstance.setStatus('show'); } catch (_) {}
    }
    refreshMap();
}

function applySavedPosition($w) {
    const pos = loadWindowPos();
    if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
        // 只写 width，高度由「标题栏 + 4:3 容器」自然撑开
        $w.css({ left: pos.x + 'px', top: pos.y + 'px', width: (pos.w || DEFAULT_W) + 'px', height: 'auto', margin: 'unset' });
    } else {
        const x = Math.max(0, window.innerWidth - DEFAULT_W - DEFAULT_INSET);
        const y = Math.max(0, window.innerHeight - DEFAULT_H - DEFAULT_INSET);
        $w.css({ left: x + 'px', top: y + 'px', width: DEFAULT_W + 'px', height: 'auto', margin: 'unset' });
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

// Minimal, self-contained drag handler (independent of SillyTavern's
// power_user.movingUI state machine, which has an uninitialized height/width
// race that collapses non-builtin widgets).
function enableDragging($w) {
    const $header = $('#realmap_titlebar');
    if (!$header.length) return;

    let dragging = false;
    let startX = 0, startY = 0;
    let originLeft = 0, originTop = 0;

    $header
        .css('cursor', 'grab')
        .on('mousedown', (e) => {
            // 不要在「禁用」按钮上发起拖动
            if (e.target.closest('#realmap_disable_btn')) return;
            if (e.button !== 0) return;
            e.preventDefault();
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const el = $w[0];
            originLeft = el.offsetLeft;
            originTop = el.offsetTop;
            $header.css('cursor', 'grabbing');
            $(document).on('mousemove.realmap_drag', onMove).on('mouseup.realmap_drag', onUp);
        })
        .on('touchstart', (e) => {
            if (e.target.closest('#realmap_disable_btn')) return;
            const t = e.originalEvent?.touches?.[0];
            if (!t) return;
            e.preventDefault();
            dragging = true;
            startX = t.clientX;
            startY = t.clientY;
            const el = $w[0];
            originLeft = el.offsetLeft;
            originTop = el.offsetTop;
            $(document).on('touchmove.realmap_drag', onTouchMove).on('touchend.realmap_drag', onUp);
        });

    function onMove(e) {
        if (!dragging) return;
        e.preventDefault();
        let nx = originLeft + (e.clientX - startX);
        let ny = originTop + (e.clientY - startY);
        const w = $w.outerWidth();
        const h = $w.outerHeight();
        // keep within viewport
        nx = Math.min(Math.max(nx, 0), window.innerWidth - w);
        ny = Math.min(Math.max(ny, 0), window.innerHeight - h);
        $w.css({ left: nx + 'px', top: ny + 'px' });
    }

    function onTouchMove(e) {
        if (!dragging) return;
        const t = e.originalEvent?.touches?.[0];
        if (!t) return;
        e.preventDefault();
        let nx = originLeft + (t.clientX - startX);
        let ny = originTop + (t.clientY - startY);
        const w = $w.outerWidth();
        const h = $w.outerHeight();
        nx = Math.min(Math.max(nx, 0), window.innerWidth - w);
        ny = Math.min(Math.max(ny, 0), window.innerHeight - h);
        $w.css({ left: nx + 'px', top: ny + 'px' });
    }

    function onUp() {
        if (!dragging) return;
        dragging = false;
        $header.css('cursor', 'grab');
        $(document).off('.realmap_drag');
        // persist
        const left = parseInt($w.css('left')) || 0;
        const top = parseInt($w.css('top')) || 0;
        const w = parseInt($w.css('width')) || DEFAULT_W;
        const h = parseInt($w.css('height')) || DEFAULT_H;
        saveWindowPos(left, top, w, h);
    }
}

async function ensureMap() {
    if (mapInstance) return mapInstance;
    const s = ensureBaseSettings();
    if (!s.key) return null; // 未配置 key，refreshMap 会显示文字提示
    const AMap = await loadAmap(s.key, s.securityCode);
    mapContainer = document.getElementById('realmap_map_container');
    if (!mapContainer) return null;
    mapInstance = new AMap.Map(mapContainer, {
        zoom: 12,
        scrollWheel: true,
        dragEnable: true,
        doubleClickZoom: false,
        keyboardEnable: false,
    });
    layerController = createLayerController(mapInstance, 'realmap_mm');
    return mapInstance;
}

export async function refreshMap() {
    if (!isExtensionEnabledForChat()) {
        hideMinimap();
        return;
    }
    if (isMobile()) return;
    const s = ensureBaseSettings();
    const state = getChatState();
    const $hint = $('#realmap_clean_state_hint');
    if (!s.key) {
        $hint.text('未配置高德 Key，请在扩展设置中填写。').show();
        refreshPanoramaButton();
        return;
    }
    $hint.text('请开始游玩');
    if (!state) {
        $hint.show();
        refreshPanoramaButton();
        return;
    }
    $hint.hide();
    try {
        const m = await ensureMap();
        if (!m || !isExtensionEnabledForChat() || getChatState() !== state) {
            refreshPanoramaButton();
            return;
        }
        await renderStateOnMap(m, state);
        if (!isExtensionEnabledForChat() || getChatState() !== state) return;
    } catch (e) {
        console.error('[realmap] refresh map failed', e);
    }
    refreshPanoramaButton();
}

async function renderStateOnMap(map, state) {
    map.clearMap();
    const AMap = window.AMap;
    if (!AMap) return;
    if (state.mode === 'idle' && typeof state.lng === 'number' && typeof state.lat === 'number') {
        const marker = new AMap.Marker({
            position: [state.lng, state.lat],
            icon: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png',
            anchor: 'bottom-center',
        });
        map.add(marker);
        map.setCenter([state.lng, state.lat]);
    } else if (state.mode === 'moving' && state.from && state.to) {
        const currentPosition = getMovingRoutePosition(state);
        const routeOverlays = addAmapRoutePolyline(
            map,
            AMap,
            state.polyline,
            { progressRatio: state.progress_ratio },
        );
        const fromM = new AMap.Marker({
            position: [currentPosition.lng, currentPosition.lat],
            icon: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png',
            anchor: 'bottom-center',
            zIndex: 121,
        });
        const toM = createAmapDestinationMarker(AMap, state.to);
        map.add([fromM, toM].filter(Boolean));
        fitMovingMapView(map, [...routeOverlays, fromM, toM], currentPosition, [28, 28, 28, 28]);
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

function bindFullscreenButton() {
    $('#realmap_mm_fullscreen_btn').on('click', async (e) => {
        e.stopPropagation();
        try {
            await openFullscreen({ getState: getChatState, refreshMinimap: refreshMap, afterClose: () => refreshMap() });
        } catch (err) {
            console.error('[realmap] open fullscreen failed', err);
        }
    });
}

function bindPanoramaButton() {
    $('#realmap_mm_panorama_btn').on('click', () => {
        const pos = getCurrentPosition();
        if (!pos) return;
        const url = `https://api.map.baidu.com/marker?location=${pos.lat},${pos.lng}&coord_type=gcj02&output=html&title=现实地图&src=webapp.realmap`;
        window.open(url, '_blank', 'noopener');
    });
}

function refreshPanoramaButton() {
    const ok = !!getCurrentPosition();
    $('#realmap_mm_panorama_btn').toggleClass('disabled', !ok);
}

// ===== 移动端悬浮球 =====
function showFloatingBall() {
    if (!floatingBallEl) {
        floatingBallEl = document.createElement('div');
        floatingBallEl.id = 'realmap_floating_ball';
        floatingBallEl.className = 'realmap_floating_ball realmap_fb_focused';
        floatingBallEl.textContent = '🗺️';
        document.body.appendChild(floatingBallEl);
        floatingBallEl.style.left = (window.innerWidth - 72) + 'px';
        floatingBallEl.style.top = (window.innerHeight - 160) + 'px';
        bindBallEvents(floatingBallEl);
    }
    floatingBallEl.style.display = 'flex';
    setBallFocused(true);
}

function hideFloatingBall() {
    if (floatingBallEl) floatingBallEl.style.display = 'none';
    clearTimeout(ballDefocusTimer);
}

function setBallFocused(focused) {
    ballFocused = focused;
    if (!floatingBallEl) return;
    if (focused) {
        floatingBallEl.classList.add('realmap_fb_focused');
        floatingBallEl.classList.remove('realmap_fb_defocused');
        floatingBallEl.style.transform = 'translate(0, 0)';
        floatingBallEl.style.opacity = '1';
    } else {
        floatingBallEl.classList.add('realmap_fb_defocused');
        floatingBallEl.classList.remove('realmap_fb_focused');
        shrinkToNearestEdge();
        floatingBallEl.style.opacity = '0.5';
    }
}

function shrinkToNearestEdge() {
    if (!floatingBallEl) return;
    const rect = floatingBallEl.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    if (centerX < window.innerWidth / 2) {
        floatingBallEl.style.transform = 'translate(-28px, 0)';
    } else {
        floatingBallEl.style.transform = 'translate(28px, 0)';
    }
}

function bindBallEvents(el) {
    let touchStartX = 0, touchStartY = 0;
    let ballStartX = 0, ballStartY = 0;
    let dragging = false;
    let wasDefocused = false;

    el.addEventListener('touchstart', (e) => {
        e.stopPropagation();
        const t = e.touches[0];
        touchStartX = t.clientX;
        touchStartY = t.clientY;
        ballStartX = parseInt(el.style.left) || 0;
        ballStartY = parseInt(el.style.top) || 0;
        dragging = false;
        wasDefocused = !ballFocused;
        if (!ballFocused) setBallFocused(true);
    }, { passive: false });

    el.addEventListener('touchmove', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const t = e.touches[0];
        const dx = t.clientX - touchStartX;
        const dy = t.clientY - touchStartY;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) dragging = true;
        if (dragging) {
            let nx = ballStartX + dx;
            let ny = ballStartY + dy;
            nx = Math.max(-28, Math.min(nx, window.innerWidth - 28));
            ny = Math.max(-28, Math.min(ny, window.innerHeight - 28));
            el.style.left = nx + 'px';
            el.style.top = ny + 'px';
            el.style.transform = 'translate(0, 0)';
        }
    }, { passive: false });

    el.addEventListener('touchend', (e) => {
        e.stopPropagation();
        if (!dragging) {
            if (!wasDefocused && ballFocused) {
                openFullscreen({
                    getState: getChatState,
                    refreshMinimap: refreshMap,
                    afterClose: () => refreshMap(),
                    onDisableClick: _onDisableClick,
                    onRejudge: _onRejudge,
                });
            }
        } else {
            const rect = el.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const EDGE_MARGIN = 8;
            if (centerX < window.innerWidth / 2) {
                el.style.left = EDGE_MARGIN + 'px';
            } else {
                el.style.left = (window.innerWidth - 56 - EDGE_MARGIN) + 'px';
            }
        }
        clearTimeout(ballDefocusTimer);
    });

    document.addEventListener('touchstart', (e) => {
        if (floatingBallEl && floatingBallEl.style.display !== 'none' && ballFocused) {
            if (!floatingBallEl.contains(e.target)) {
                setBallFocused(false);
            }
        }
    }, { passive: true });
}

export async function initMinimap({ onDisableClick, onRejudge }) {
    _onDisableClick = onDisableClick;
    _onRejudge = onRejudge;
    if (isMobile()) return;
    const $w = $(`#${WIDGET_ID}`);
    if (!$w.length) return;
    applySavedPosition($w);
    enableDragging($w);
    bindZoom();
    bindFullscreenButton();
    bindPanoramaButton();
    bindDragEnd($w);
    $('#realmap_disable_btn').on('click', (e) => {
        e.stopPropagation();
        if (onDisableClick) onDisableClick();
    });
    $('#realmap_rejudge_btn').on('click', (e) => {
        e.stopPropagation();
        if (onRejudge) onRejudge();
    });
}
