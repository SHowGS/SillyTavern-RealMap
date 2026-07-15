import { loadAmap } from './amap.js';
import { ensureBaseSettings, getChatState, findLastAiMessage, setChatState, getVisibleMessages } from './state.js';
import { getContext } from '../../../extensions.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';

let fsMap = null;
let fsContainer = null;
let fsOpen = false;
let ctx_ = null;
let runtime = null;

async function ensureFsMap() {
    if (fsMap) return fsMap;
    const s = ensureBaseSettings();
    const AMap = await loadAmap(s.key, s.securityCode);
    fsContainer = document.getElementById('realmap_map_fullscreen');
    if (!fsContainer) return null;
    fsMap = new AMap.Map(fsContainer, {
        zoom: 12,
        scrollWheel: true,
        dragEnable: true,
    });
    bindMapClick(fsMap, AMap);
    return fsMap;
}

function clearSelectionMarker() {
    if (!fsMap) return;
    const overlays = fsMap.getAllOverlays();
    overlays.forEach(o => {
        if (o?.CLASS_NAME === 'AMap.Marker' && o.getExtData?.()?.realmap === 'selection') {
            fsMap.remove(o);
        }
    });
}

function clearRedAndYellow() {
    if (!fsMap) return;
    const overlays = fsMap.getAllOverlays();
    overlays.forEach(o => {
        const tag = o?.CLASS_NAME === 'AMap.Marker' && o.getExtData?.()?.realmap;
        if (tag === 'red' || tag === 'yellow') fsMap.remove(o);
    });
}

function setRedMarker(lng, lat) {
    clearRedAndYellow();
    fsMap.add(new window.AMap.Marker({
        position: [lng, lat],
        icon: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png',
        extData: { realmap: 'red' },
    }));
}

function setYellowMarker(lng, lat) {
    clearRedAndYellow();
    fsMap.add(new window.AMap.Marker({
        position: [lng, lat],
        icon: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_y.png',
        extData: { realmap: 'yellow' },
    }));
}

function placeSelectionMarker(lng, lat) {
    clearSelectionMarker();
    fsMap.add(new window.AMap.Marker({
        position: [lng, lat],
        icon: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_b.png',
        extData: { realmap: 'selection' },
    }));
    openActionMenu(lng, lat);
}

function openActionMenu(lng, lat) {
    const AMap = window.AMap;
    const menu = $('<div style="display:flex;flex-direction:column;background:rgba(0,0,0,0.8);color:#fff;min-width:120px;border-radius:4px;overflow:hidden"></div>');
    const placeholder = $('<div style="padding:6px;color:#aaa;font-size:12px;white-space:nowrap">（正在获取地名…）</div>');
    menu.append(placeholder);
    let placeName = '';
    const geocoder = new AMap.Geocoder();
    geocoder.getAddress([lng, lat], (status, result) => {
        placeName = result?.regeocode?.formattedAddress || `坐标 ${lng.toFixed(4)},${lat.toFixed(4)}`;
        placeholder.replaceWith(`<div style="padding:6px;font-size:12px;color:#aaa;white-space:nowrap">${placeName}</div>`);
        addMenuActions(menu, lng, lat, placeName);
    });
    const info = new AMap.InfoWindow({
        content: menu[0],
        isCustom: true,
        offset: new AMap.Pixel(8, -16),
    });
    info.open(fsMap, [lng, lat]);
    window.__realmap_info = info;
    info.__placeName = () => placeName;
}

function addMenuActions(menu, lng, lat, placeName) {
    const opt1 = $(`<div class="realmap_menu_item">前往此处</div>`);
    opt1.on('click', () => {
        fillInput(`前往${placeName}`);
        window.__realmap_info?.close();
    });
    const opt2 = $(`<div class="realmap_menu_item">设置此地为当前位置</div>`);
    opt2.on('click', async () => {
        window.__realmap_info?.close();
        const ok = await confirmOverwriteLocation();
        if (!ok) return;
        await overwriteCurrentUserLocation(lng, lat, placeName);
    });
    menu.append(opt1).append(opt2);
}

function fillInput(text) {
    const ta = $('#send_textarea');
    if (!ta.length) return;
    const cur = ta.val();
    ta.val(cur ? `${cur}\n${text}` : text);
    ta.trigger('input');
    ta[0].focus();
}

async function confirmOverwriteLocation() {
    const result = await Popup.show.confirm(
        '覆盖当前位置',
        '您确定使用该坐标覆盖为 user 当前位置？一旦覆盖无法撤回，错误的位置坐标会造成正文失真，请谨慎选择。',
    );
    return result === POPUP_RESULT.AFFIRMATIVE;
}

async function overwriteCurrentUserLocation(lng, lat, label) {
    const last = findLastAiMessage();
    if (!last) {
        window.toastr?.warning('未找到可写入的 AI 消息。');
        return;
    }
    const m = last.message;
    if (!m.extra) m.extra = {};
    m.extra.realmap = {
        v: 2,
        captured_at: Date.now(),
        mode: 'idle',
        lat, lng,
        label,
        degraded: { reason: '用户手动覆盖', from_prev: false },
    };
    if (Array.isArray(m.swipe_info) && typeof m.swipe_id === 'number' && m.swipe_info[m.swipe_id]) {
        m.swipe_info[m.swipe_id].extra = structuredClone(m.extra);
    }
    setChatState(m.extra.realmap, { immediate: true });
    drawFromState(runtime.getState());
    window.toastr?.success('已覆盖当前位置。');
}

function bindMapClick(map, AMap) {
    map.on('click', (e) => {
        const lng = e.lnglat.getLng();
        const lat = e.lnglat.getLat();
        placeSelectionMarker(lng, lat);
    });
}

function bindSearch() {
    const input = document.getElementById('realmap_search_input');
    const listEl = document.getElementById('realmap_search_results');
    const AMap = window.AMap;
    if (!input || !listEl) return;
    const placeSearch = new AMap.PlaceSearch({ pageSize: 8, pageIndex: 1 });
    let timer = null;
    input.addEventListener('input', () => {
        clearTimeout(timer);
        const q = input.value.trim();
        if (!q) { listEl.innerHTML = ''; listEl.style.display = 'none'; return; }
        timer = setTimeout(() => {
            placeSearch.search(q, (status, result) => {
                if (status !== 'complete' || !result?.poiList?.pois?.length) {
                    listEl.innerHTML = '<div class="realmap_search_empty">无结果</div>';
                    listEl.style.display = 'flex';
                    return;
                }
                listEl.innerHTML = '';
                result.poiList.pois.forEach(p => {
                    const item = document.createElement('div');
                    item.className = 'realmap_search_item';
                    const name = p.name || '';
                    const addr = p.address || p.cityname || '';
                    item.innerHTML = `<div class="name"></div><div class="addr"></div>`;
                    item.querySelector('.name').textContent = name;
                    item.querySelector('.addr').textContent = addr;
                    const lng = p.location?.getLng();
                    const lat = p.location?.getLat();
                    item.addEventListener('click', () => {
                        if (typeof lng === 'number' && typeof lat === 'number') {
                            fsMap.setZoomAndCenter(15, [lng, lat]);
                            placeSelectionMarker(lng, lat);
                        }
                    });
                    listEl.appendChild(item);
                });
                listEl.style.display = 'flex';
            });
        }, 300);
    });
}

function bindZoom() {
    $('#realmap_fs_zoom_in').on('click', () => fsMap?.zoomIn());
    $('#realmap_fs_zoom_out').on('click', () => fsMap?.zoomOut());
}

function drawFromState(state) {
    if (!fsMap) return;
    fsMap.clearMap();
    const AMap = window.AMap;
    if (!state) return;
    if (state.mode === 'idle' && typeof state.lng === 'number') {
        setRedMarker(state.lng, state.lat);
        fsMap.setCenter([state.lng, state.lat]);
    } else if (state.mode === 'moving') {
        clearRedAndYellow();
        if (state.from) setRedMarker(state.from.lng, state.from.lat);
        if (state.to) setYellowMarker(state.to.lng, state.to.lat);
        if (Array.isArray(state.polyline) && state.polyline.length) {
            const poly = new AMap.Polyline({ path: state.polyline, strokeColor: '#00b0ff', strokeWeight: 3, strokeStyle: 'dashed' });
            fsMap.add(poly);
            fsMap.setFitView([poly]);
        }
    }
}

export async function openFullscreen(opts) {
    runtime = opts;
    ctx_ = getContext();
    const s = ensureBaseSettings();
    const AMap = await loadAmap(s.key, s.securityCode);
    const html = buildFullscreenHtml();
    const popup = new Popup(html, POPUP_TYPE.DISPLAY, '', { large: true, wide: true, okButton: false, cancelButton: false });
    const onCloseCleanup = () => {
        fsOpen = false;
        try { if (fsMap) fsMap.destroy(); } catch (_) {}
        fsMap = null;
        fsContainer = null;
        window.__realmap_info = null;
    };
    popup.show().then(() => { onCloseCleanup(); if (opts.afterClose) opts.afterClose(); });
    await new Promise(r => requestAnimationFrame(r));
    bindZoom();
    bindSearch();
    await ensureFsMap();
    drawFromState(opts.getState());
    fsOpen = true;
}

export function isFullscreenOpen() {
    return fsOpen;
}

function buildFullscreenHtml() {
    return $(`
<div class="realmap_fullscreen">
    <div id="realmap_map_fullscreen"></div>
    <div class="realmap_fs_zoom_ctl">
        <div id="realmap_fs_zoom_in" class="realmap_zoom_btn">+</div>
        <div id="realmap_fs_zoom_out" class="realmap_zoom_btn">−</div>
    </div>
    <div class="realmap_search">
        <input id="realmap_search_input" class="text_pole" placeholder="搜索地点…" autocomplete="off" />
        <div id="realmap_search_results" class="realmap_search_results"></div>
    </div>
</div>
`);
}
