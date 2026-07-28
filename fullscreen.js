import { loadAmap } from './amap.js';
import { ensureBaseSettings, getChatState, findLastAiMessage, setChatState, getVisibleMessages, getCurrentPosition } from './state.js';
import { getContext } from '../../../extensions.js';
import { Popup, POPUP_RESULT } from '../../../popup.js';
import { createLayerController } from './layer-control.js';
import { searchRankedPlaces, getRankedPoiLocation } from './place-search.js';
import { isMobile } from '../../../RossAscends-mods.js';
import {
    addAmapRoutePolyline,
    createAmapDestinationMarker,
    fitMovingMapView,
    getMovingRoutePosition,
} from './map-state.js';

let fsMap = null;
let fsContainer = null;
let fsHostEl = null;
let fsOpen = false;
let ctx_ = null;
let runtime = null;
let layerController = null;
let previewPlugin = null;
let previewInfo = null;
let previewMode = null;
let previewDest = null;
let sliderEl = null;
let previewPolylines = [];
let transferPanelEl = null;

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
    layerController = createLayerController(fsMap, 'realmap_fs');
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
    clearRoutePreviewFull();
}

// ===== 路线预览 =====
function clearRoutePreview() {
    if (previewPlugin) {
        try { previewPlugin.clear(); } catch (_) {}
        previewPlugin = null;
    }
    if (previewInfo) {
        try { previewInfo.close(); } catch (_) {}
        previewInfo = null;
    }
    if (previewPolylines.length) {
        previewPolylines.forEach(p => { try { fsMap.remove(p); } catch (_) {} });
        previewPolylines = [];
    }
    hideTransferPanel();
}

function clearRoutePreviewFull() {
    clearRoutePreview();
    hideRouteSlider();
    previewMode = null;
    previewDest = null;
}

function hideRouteSlider() {
    if (sliderEl) {
        sliderEl.style.display = 'none';
        $(sliderEl).off('click');
    }
    sliderEl = null;
}

function showRouteSlider(mode, currentPos = 0) {
    const el = document.getElementById('realmap_route_slider');
    if (!el) return;
    sliderEl = el;
    const mobile = isMobile();
    const opts = el.querySelectorAll('.realmap_slider_option');
    if (mode === 'driving') {
        opts[0].textContent = mobile ? '高速' : '高速优先';
        opts[1].textContent = mobile ? '非高速' : '不走高速';
    } else if (mode === 'transfer') {
        opts[0].textContent = mobile ? '地铁' : '优先地铁';
        opts[1].textContent = mobile ? '公交' : '优先公交';
    } else {
        hideRouteSlider();
        return;
    }
    opts.forEach(o => o.classList.remove('disabled'));
    el.style.display = 'flex';
    setSliderPosition(currentPos);
    bindSliderEvents(mode);
}

function setSliderPosition(pos) {
    if (!sliderEl) return;
    const thumb = sliderEl.querySelector('.realmap_slider_thumb');
    if (thumb) {
        thumb.style.left = pos === 1 ? 'calc(50% + 0px)' : '3px';
    }
    sliderEl.querySelectorAll('.realmap_slider_option').forEach((o, i) => {
        o.classList.toggle('active', i === pos);
    });
}

function bindSliderEvents(mode) {
    $(sliderEl).off('click').on('click', '.realmap_slider_option', (e) => {
        e.stopPropagation();
        const pos = Number($(e.currentTarget).data('pos'));
        setSliderPosition(pos);
        if (!previewDest) return;
        const policy = resolvePolicy(mode, pos);
        showRoutePreview(mode, previewDest.lng, previewDest.lat, policy);
    });
}

function resolvePolicy(mode, pos) {
    if (mode === 'driving') return pos === 0 ? 19 : 13;
    if (mode === 'transfer') return pos === 0 ? 0 : 5;
    return null;
}

async function showRoutePreview(mode, destLng, destLat, policy = null) {
    const origin = getCurrentPosition();
    if (!origin) {
        window.toastr?.warning('无当前位置，无法预览路线。');
        return;
    }
    clearRoutePreview();
    previewMode = mode;
    previewDest = { lng: destLng, lat: destLat };

    const AMap = window.AMap;
    const modeMap = {
        driving:  { cls: AMap.Driving,  label: '驾车' },
        walking:  { cls: AMap.Walking,  label: '步行' },
        riding:   { cls: AMap.Riding,   label: '骑行' },
        transfer: { cls: AMap.Transfer, label: '公交' },
    };
    const m = modeMap[mode];
    if (!m?.cls) return;

    let usePolicy = policy;
    if (usePolicy === null) {
        if (mode === 'driving') usePolicy = 19;
        else if (mode === 'transfer') usePolicy = 0;
    }

    const opts = {};
    if (mode !== 'transfer' && mode !== 'driving') opts.map = fsMap;
    if (usePolicy !== null) opts.policy = usePolicy;

    // Transfer 需要显式 city，先用 Geocoder 从起点坐标推断城市
    if (mode === 'transfer') {
        try {
            const geocoder = new AMap.Geocoder();
            const cityRes = await new Promise((resolve) => {
                geocoder.getAddress([origin.lng, origin.lat], (s, r) => resolve(s === 'complete' ? r : null));
            });
            const comp = cityRes?.regeocode?.addressComponent;
            const cityName = comp?.city || comp?.province || '';
            opts.city = cityName || '全国';
            if (comp?.city && comp.city.length > 0 && comp.city !== '[]') {
                opts.cityd = cityName;
            }
        } catch (_) {
            opts.city = '全国';
        }
    }

    previewPlugin = new m.cls(opts);
    const originLngLat = mode === 'transfer' ? new AMap.LngLat(origin.lng, origin.lat) : [origin.lng, origin.lat];
    const destLngLat = mode === 'transfer' ? new AMap.LngLat(destLng, destLat) : [destLng, destLat];
    previewPlugin.search(originLngLat, destLngLat, (status, result) => {
        if (status !== 'complete') {
            window.toastr?.warning(`${m.label}：无可用路线。`);
            clearRoutePreview();
            return;
        }
        const route = mode === 'transfer' ? result.plans?.[0] : result.routes?.[0];
        if (!route) {
            window.toastr?.warning(`${m.label}：无可用路线。`);
            clearRoutePreview();
            return;
        }
        const min = Math.round(route.time / 60);
        const km = (route.distance / 1000).toFixed(1);
        const content = `<div style="padding:6px 10px;background:rgba(0,0,0,0.8);color:#fff;border-radius:4px;font-size:12px;white-space:nowrap">${m.label} · ${km}km · ${min}分钟</div>`;
        previewInfo = new AMap.InfoWindow({
            content,
            isCustom: true,
            autoMove: false,
            offset: new AMap.Pixel(0, -50),
        });
        previewInfo.open(fsMap, [destLng, destLat]);

        if (mode === 'driving') {
            drawDrivingRoute(route);
            const pos = usePolicy === 13 ? 1 : 0;
            showRouteSlider('driving', pos);
        } else if (mode === 'transfer') {
            drawTransferRoute(route);
            showTransferPanel(route);
            const pos = usePolicy === 5 ? 1 : 0;
            showRouteSlider('transfer', pos);
            syncSliderToPanel();
        }
    });
}

function drawDrivingRoute(route) {
    const AMap = window.AMap;
    previewPolylines = [];
    const pts = [];
    if (route.steps) {
        for (const step of route.steps) {
            const path = step.path;
            if (!path) continue;
            if (typeof path === 'string') {
                path.split(';').forEach(p => {
                    const [lng, lat] = p.split(',');
                    if (lng && lat) pts.push([Number(lng), Number(lat)]);
                });
            } else if (Array.isArray(path)) {
                path.forEach(p => {
                    if (typeof p.getLng === 'function') pts.push([p.getLng(), p.getLat()]);
                    else if (typeof p.lng === 'number') pts.push([p.lng, p.lat]);
                    else if (Array.isArray(p)) pts.push([Number(p[0]), Number(p[1])]);
                });
            }
        }
    }
    if (!pts.length && Array.isArray(route.path)) {
        route.path.forEach(p => {
            if (typeof p.getLng === 'function') pts.push([p.getLng(), p.getLat()]);
            else if (typeof p.lng === 'number') pts.push([p.lng, p.lat]);
            else if (Array.isArray(p)) pts.push([Number(p[0]), Number(p[1])]);
        });
    }
    if (pts.length) {
        const border = new AMap.Polyline({
            path: pts, strokeColor: '#ffffff',
            strokeWeight: 9, strokeOpacity: 1,
            strokeStyle: 'solid', zIndex: 50,
        });
        const poly = new AMap.Polyline({
            path: pts, strokeColor: '#00b0ff',
            strokeWeight: 5, strokeOpacity: 0.9,
            showDir: true, zIndex: 51,
        });
        fsMap.add(border);
        fsMap.add(poly);
        previewPolylines.push(border, poly);
        fsMap.setFitView(previewPolylines);
    }
}

function drawTransferRoute(plan) {
    const AMap = window.AMap;
    previewPolylines = [];
    for (const seg of plan.segments) {
        const tm = seg.transit_mode;
        const path = seg.transit?.path;
        if (!path || !path.length) continue;
        const pts = path.map(p => {
            if (typeof p.getLng === 'function') return [p.getLng(), p.getLat()];
            if (typeof p.lng === 'number') return [p.lng, p.lat];
            return null;
        }).filter(Boolean);

        let color, weight, style, isWalk;
        if (tm === 'WALK') {
            color = '#888'; weight = 4; style = 'dashed'; isWalk = true;
        } else if (tm === 'SUBWAY') {
            color = '#e91e63'; weight = 5; style = 'solid'; isWalk = false;
        } else {
            color = '#00b0ff'; weight = 5; style = 'solid'; isWalk = false;
        }

        if (!isWalk) {
            const border = new AMap.Polyline({
                path: pts, strokeColor: '#ffffff',
                strokeWeight: 9, strokeOpacity: 1,
                strokeStyle: 'solid', zIndex: 50,
            });
            const poly = new AMap.Polyline({
                path: pts, strokeColor: color,
                strokeWeight: weight, strokeStyle: style,
                strokeOpacity: 0.9, showDir: true, zIndex: 51,
            });
            fsMap.add(border);
            fsMap.add(poly);
            previewPolylines.push(border, poly);
        } else {
            const poly = new AMap.Polyline({
                path: pts, strokeColor: color,
                strokeWeight: weight, strokeStyle: style,
                strokeOpacity: 0.9,
            });
            fsMap.add(poly);
            previewPolylines.push(poly);
        }
    }
    if (previewPolylines.length) fsMap.setFitView(previewPolylines);
}

function syncSliderToPanel() {
    if (sliderEl && transferPanelEl && isMobile()) {
        requestAnimationFrame(() => {
            const panelH = transferPanelEl.offsetHeight;
            sliderEl.style.bottom = (panelH + 68) + 'px';
        });
    }
}

function showTransferPanel(plan) {
    const el = document.getElementById('realmap_transfer_panel');
    if (!el) return;
    transferPanelEl = el;

    const totalMin = Math.round(plan.time / 60);
    const totalKm = (plan.distance / 1000).toFixed(1);
    const walkKm = (plan.walking_distance / 1000).toFixed(1);
    const cost = plan.cost || '';

    let segmentsHtml = '';
    plan.segments.forEach((seg, i) => {
        const tm = seg.transit_mode;
        const t = seg.transit;
        const segMin = Math.round(seg.time / 60);
        const segKm = (seg.distance / 1000).toFixed(1);

        if (tm === 'WALK') {
            segmentsHtml += `
<div class="realmap_tp_seg realmap_tp_walk">
    <div class="realmap_tp_seg_line">
        <div class="realmap_tp_seg_dot realmap_tp_dot_walk"></div>
        <div class="realmap_tp_seg_info">
            <div class="realmap_tp_seg_title">${seg.instruction || '步行'}</div>
            <div class="realmap_tp_seg_meta">
                <span>${segMin}分钟</span>
                <span>${segKm}km</span>
            </div>
        </div>
    </div>
</div>`;
        } else {
            const isMetro = tm === 'SUBWAY';
            const line = t?.lines?.[0] || {};
            const onStation = t?.on_station?.name || '';
            const offStation = t?.off_station?.name || '';
            const viaNum = t?.via_num || 0;
            const viaStops = t?.via_stops || [];
            const entrance = t?.entrance?.name || '';
            const exit = t?.exit?.name || '';
            const startTime = line.start_time ? `${line.start_time.slice(0,2)}:${line.start_time.slice(2)}` : '';
            const endTime = line.end_time ? `${line.end_time.slice(0,2)}:${line.end_time.slice(2)}` : '';

            segmentsHtml += `
<div class="realmap_tp_seg ${isMetro ? 'realmap_tp_metro' : 'realmap_tp_bus'}">
    <div class="realmap_tp_seg_line">
        <div class="realmap_tp_seg_dot ${isMetro ? 'realmap_tp_dot_metro' : 'realmap_tp_dot_bus'}"></div>
        <div class="realmap_tp_seg_info">
            <div class="realmap_tp_seg_title">${line.name || seg.instruction || ''}</div>
            <div class="realmap_tp_seg_detail">
                <span class="realmap_tp_stop">${onStation}</span>
                <span class="realmap_tp_arrow">→</span>
                <span class="realmap_tp_stop">${offStation}</span>
            </div>
            <div class="realmap_tp_seg_meta">
                <span>${viaNum}站</span>
                <span>${segMin}分钟</span>
                <span>${segKm}km</span>
                ${entrance ? `<span>入口 ${entrance}</span>` : ''}
                ${exit ? `<span>出口 ${exit}</span>` : ''}
                ${startTime ? `<span>首班 ${startTime}</span>` : ''}
                ${endTime ? `<span>末班 ${endTime}</span>` : ''}
            </div>
            ${viaStops.length ? `
            <div class="realmap_tp_seg_expand" data-seg="${i}">
                <span class="realmap_tp_expand_toggle">展开途经站 (${viaStops.length})</span>
                <div class="realmap_tp_via_stops" style="display:none">
                    ${viaStops.map((s, j) => `<div class="realmap_tp_via_stop">${j+1}. ${s.name || ''}</div>`).join('')}
                </div>
            </div>` : ''}
        </div>
    </div>
</div>`;
        }
    });

    const mobile = isMobile();
    el.innerHTML = `
<div class="realmap_tp_header" id="realmap_tp_toggle">
    <div class="realmap_tp_summary">
        <span class="realmap_tp_time">${totalMin}分钟</span>
        <span class="realmap_tp_dist">${totalKm}km</span>
        <span class="realmap_tp_walk_dist">步行${walkKm}km</span>
        ${cost ? `<span class="realmap_tp_cost">${cost}元</span>` : ''}
        ${mobile ? `<span class="realmap_tp_collapse">▾</span>` : ''}
    </div>
</div>
<div class="realmap_tp_segments" id="realmap_tp_body" style="${mobile ? 'display:none' : ''}">${segmentsHtml}</div>`;

    el.style.display = 'block';

    if (mobile) {
        const header = el.querySelector('#realmap_tp_toggle');
        const body = el.querySelector('#realmap_tp_body');
        const collapse = el.querySelector('.realmap_tp_collapse');
        header.style.cursor = 'pointer';
        header.addEventListener('click', () => {
            const isHidden = body.style.display === 'none';
            body.style.display = isHidden ? 'block' : 'none';
            if (collapse) collapse.textContent = isHidden ? '▴' : '▾';
            syncSliderToPanel();
        });
    }

    el.querySelectorAll('.realmap_tp_expand_toggle').forEach(t => {
        t.addEventListener('click', (e) => {
            const stops = e.target.nextElementSibling;
            const isHidden = stops.style.display === 'none';
            stops.style.display = isHidden ? 'block' : 'none';
            e.target.textContent = isHidden ? '收起途经站' : `展开途经站 (${stops.children.length})`;
        });
    });
}

function hideTransferPanel() {
    if (transferPanelEl) {
        transferPanelEl.style.display = 'none';
        transferPanelEl.innerHTML = '';
    }
    transferPanelEl = null;
    if (sliderEl) sliderEl.style.bottom = '';
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
    clearMarkerByTag('red');
    const marker = new window.AMap.Marker({
        position: [lng, lat],
        icon: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_r.png',
        anchor: 'bottom-center',
        zIndex: 121,
        extData: { realmap: 'red' },
    });
    fsMap.add(marker);
    return marker;
}

function setYellowMarker(lng, lat) {
    clearMarkerByTag('yellow');
    const marker = createAmapDestinationMarker(
        window.AMap,
        { lng, lat },
        { extData: { realmap: 'yellow' } },
    );
    if (marker) fsMap.add(marker);
    return marker;
}

function clearMarkerByTag(tag) {
    if (!fsMap) return;
    const overlays = fsMap.getAllOverlays();
    overlays.forEach((overlay) => {
        const markerTag = overlay?.CLASS_NAME === 'AMap.Marker'
            ? overlay.getExtData?.()?.realmap
            : '';
        if (markerTag === tag) fsMap.remove(overlay);
    });
}

function placeSelectionMarker(lng, lat) {
    clearSelectionMarker();
    fsMap.add(new window.AMap.Marker({
        position: [lng, lat],
        icon: 'https://webapi.amap.com/theme/v1.3/markers/n/mark_b.png',
        anchor: 'bottom-center',
        extData: { realmap: 'selection' },
    }));
    openActionMenu(lng, lat);
    fsMap.setCenter([lng, lat], true);
    // setCenter 后 InfoWindow 的像素位置不更新，需要重新 open 强制重定位
    setTimeout(() => {
        if (window.__realmap_info) {
            window.__realmap_info.open(fsMap, [lng, lat]);
        }
    }, 100);
}

function openActionMenu(lng, lat) {
    const AMap = window.AMap;
    const menu = $('<div style="display:flex;flex-direction:column;background:rgba(0,0,0,0.8);color:#fff;min-width:120px;border-radius:4px"></div>');
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
        autoMove: false,
        // 锚点在 InfoWindow 左上角，offset 把它推到 marker 右侧，避免压住蓝色箭头
        offset: new AMap.Pixel(30, -32),
    });
    info.open(fsMap, [lng, lat]);
    window.__realmap_info = info;
    info.__placeName = () => placeName;
}

function addMenuActions(menu, lng, lat, placeName) {
    const opt1 = $(`
<div class="realmap_menu_item realmap_has_submenu">
    前往此处
    <div class="realmap_submenu">
        <div class="realmap_menu_item" data-go="walking">步行</div>
        <div class="realmap_menu_item" data-go="riding">骑行</div>
        <div class="realmap_menu_item realmap_has_submenu">
            驾车
            <div class="realmap_submenu">
                <div class="realmap_menu_item" data-go="driving-fast">高速优先</div>
                <div class="realmap_menu_item" data-go="driving-no-fast">不走高速</div>
            </div>
        </div>
        <div class="realmap_menu_item realmap_has_submenu">
            公交
            <div class="realmap_submenu">
                <div class="realmap_menu_item" data-go="transit-metro">优先地铁</div>
                <div class="realmap_menu_item" data-go="transit-bus">优先公交</div>
            </div>
        </div>
    </div>
</div>`);
    opt1.find('.realmap_submenu [data-go]').on('click', (e) => {
        e.stopPropagation();
        const go = $(e.currentTarget).data('go');
        const prompts = {
            'walking':         `步行前往${placeName}`,
            'riding':          `骑行前往${placeName}`,
            'driving-fast':    `驾车优先高速前往${placeName}`,
            'driving-no-fast': `驾车不走高速前往${placeName}`,
            'transit-metro':   `公交(优先地铁)前往${placeName}`,
            'transit-bus':     `公交(优先公交)前往${placeName}`,
        };
        fillInput(prompts[go] || `前往${placeName}`);
        window.__realmap_info?.close();
    });
    const opt2 = $(`<div class="realmap_menu_item">设置此地为当前位置</div>`);
    opt2.on('click', async () => {
        window.__realmap_info?.close();
        const ok = await confirmOverwriteLocation();
        if (!ok) return;
        await overwriteCurrentUserLocation(lng, lat, placeName);
    });
    const opt3 = $(`
<div class="realmap_menu_item realmap_has_submenu">
    路线预览
    <div class="realmap_submenu">
        <div class="realmap_menu_item" data-mode="driving">驾车</div>
        <div class="realmap_menu_item" data-mode="walking">步行</div>
        <div class="realmap_menu_item" data-mode="riding">骑行</div>
        <div class="realmap_menu_item" data-mode="transfer">公交</div>
    </div>
</div>`);
    opt3.find('.realmap_submenu .realmap_menu_item').on('click', (e) => {
        e.stopPropagation();
        const mode = $(e.currentTarget).data('mode');
        window.__realmap_info?.close();
        showRoutePreview(mode, lng, lat);
    });
    menu.append(opt1).append(opt2).append(opt3);
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
        const hasSelection = fsMap.getAllOverlays('marker').some(
            o => o.getExtData?.()?.realmap === 'selection'
        );
        if (hasSelection) {
            clearSelectionMarker();
            window.__realmap_info?.close();
            window.__realmap_info = null;
        } else {
            placeSelectionMarker(lng, lat);
        }
    });
    map.on('rightclick', (e) => {
        if (isMobile()) return;
        clearSelectionMarker();
        window.__realmap_info?.close();
        window.__realmap_info = null;
    });
    map.on('moveend', () => {
        if (previewPlugin) return;  // 路线预览状态下不触发
        const sel = fsMap.getAllOverlays('marker').find(
            o => o.getExtData?.()?.realmap === 'selection'
        );
        if (!sel) return;
        const pos = sel.getPosition();
        const pixel = fsMap.lngLatToContainer(pos);
        const size = fsMap.getSize();
        const margin = 50;
        if (pixel.x < -margin || pixel.x > size.width + margin ||
            pixel.y < -margin || pixel.y > size.height + margin) {
            fsMap.remove(sel);
            window.__realmap_info?.close();
            window.__realmap_info = null;
        }
    });
}

function bindSearch() {
    const input = document.getElementById('realmap_search_input');
    const listEl = document.getElementById('realmap_search_results');
    const AMap = window.AMap;
    if (!input || !listEl) return;
    let timer = null;

    const renderPois = (ranked, origin) => {
        listEl.innerHTML = '';
        ranked.forEach((candidate) => {
            const { poi: p, distance } = candidate;
            const location = getRankedPoiLocation(candidate);
            if (!location) return;
            const item = document.createElement('div');
            item.className = 'realmap_search_item';
            const name = p.name || '';
            const addr = p.address || p.cityname || '';
            const { lng, lat } = location;
            let addrText = addr;
            if (origin && Number.isFinite(distance)) {
                const distText = distance < 1000 ? `${Math.round(distance)}m` : `${(distance/1000).toFixed(1)}km`;
                addrText = addr ? `${addr} · ${distText}` : distText;
            }
            item.innerHTML = `<div class="name"></div><div class="addr"></div>`;
            item.querySelector('.name').textContent = name;
            item.querySelector('.addr').textContent = addrText;
            item.addEventListener('click', () => {
                input.blur();
                fsMap.setZoomAndCenter(16, [lng, lat], true);
                setTimeout(() => placeSelectionMarker(lng, lat), 100);
            });
            listEl.appendChild(item);
        });
        listEl.style.display = 'flex';
    };

    input.addEventListener('input', () => {
        clearTimeout(timer);
        const q = input.value.trim();
        if (!q) { listEl.innerHTML = ''; listEl.style.display = 'none'; return; }
        timer = setTimeout(async () => {
            const origin = getCurrentPosition() || (fsMap ? (() => {
                const c = fsMap.getCenter();
                return { lng: c.getLng(), lat: c.getLat() };
            })() : null);
            const ranked = await searchRankedPlaces(AMap, q, { origin });
            if (!ranked.length) {
                listEl.innerHTML = '<div class="realmap_search_empty">无结果</div>';
                listEl.style.display = 'flex';
                return;
            }
            renderPois(ranked, origin);
        }, 300);
    });
    input.addEventListener('blur', () => {
        setTimeout(() => {
            listEl.innerHTML = '';
            listEl.style.display = 'none';
        }, 150);
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
        const currentPosition = getMovingRoutePosition(state);
        const routeOverlays = addAmapRoutePolyline(
            fsMap,
            AMap,
            state.polyline,
            { progressRatio: state.progress_ratio },
        );
        const currentMarker = currentPosition
            ? setRedMarker(currentPosition.lng, currentPosition.lat)
            : null;
        const destinationMarker = state.to
            ? setYellowMarker(state.to.lng, state.to.lat)
            : null;
        fitMovingMapView(
            fsMap,
            [...routeOverlays, currentMarker, destinationMarker],
            currentPosition,
            [80, 60, 80, 60],
        );
    }
}

export async function openFullscreen(opts) {
    runtime = opts;
    ctx_ = getContext();
    const s = ensureBaseSettings();
    const AMap = await loadAmap(s.key, s.securityCode);

    // 直接把全屏地图挂到 body 上，并用浏览器 Fullscreen API 真全屏
    const $host = $(buildFullscreenHtml());
    $('body').append($host);
    fsHostEl = $host[0];

    const exitFullscreen = () => {
        clearRoutePreviewFull();
        try { if (fsMap) fsMap.destroy(); } catch (_) {}
        fsMap = null;
        fsContainer = null;
        layerController = null;
        window.__realmap_info = null;
        $host.remove();
        fsHostEl = null;
        fsOpen = false;
        document.removeEventListener('fullscreenchange', onFsChange);
        document.removeEventListener('keydown', onKey);
        if (opts.afterClose) opts.afterClose();
    };
    let closed = false;
    const onFsChange = () => {
        if (document.fullscreenElement == null && !closed) {
            closed = true;
            exitFullscreen();
        }
    };
    const onKey = (e) => {
        if (e.key === 'Escape' && !closed) {
            closed = true;
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => exitFullscreen());
            } else {
                exitFullscreen();
            }
        }
    };
    // 给所有 UI 覆盖层拦截 click，防止下传到地图层触发 marker
    $host.find('.realmap_fs_close_ctl, .realmap_fs_layer_ctl, .realmap_fs_zoom_ctl, .realmap_search, .realmap_panorama_btn, #realmap_route_slider, #realmap_transfer_panel, .realmap_fs_disable_ctl')
        .on('click mousedown', (e) => { e.stopPropagation(); });

    // 移动端禁用 + 重新判断按钮
    if (isMobile() && opts.onDisableClick) {
        $host.find('.realmap_fs_disable_ctl').show();
        $host.find('#realmap_fs_disable_btn').on('click', () => opts.onDisableClick());
    }
    if (isMobile() && opts.onRejudge) {
        $host.find('#realmap_fs_rejudge_btn').show();
        $host.find('#realmap_fs_rejudge_btn').on('click', () => opts.onRejudge());
    }

    // 全景按钮：用当前位置（moving 模式取 from）打开百度街景
    $host.find('#realmap_fs_panorama_btn').on('click', () => {
        const pos = getCurrentPosition();
        if (!pos) return;
        const url = `https://api.map.baidu.com/marker?location=${pos.lat},${pos.lng}&coord_type=gcj02&output=html&title=现实地图&src=webapp.realmap`;
        window.open(url, '_blank', 'noopener');
    });

    $host.find('#realmap_fs_close').on('click', () => {
        if (closed) return;
        closed = true;
        if (document.fullscreenElement) {
            document.exitFullscreen().then(exitFullscreen).catch(exitFullscreen);
        } else {
            exitFullscreen();
        }
    });

    try {
        await fsHostEl.requestFullscreen();
    } catch (_) {
        // 降级：没拿到真全屏也能用，元素本身已全屏铺开
    }
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('keydown', onKey);

    await new Promise(r => requestAnimationFrame(r));
    bindZoom();
    bindSearch();
    await ensureFsMap();
    drawFromState(opts.getState());
    const panoOk = !!getCurrentPosition();
    $host.find('#realmap_fs_panorama_btn').toggleClass('disabled', !panoOk);
    fsOpen = true;
}

export function isFullscreenOpen() {
    return fsOpen;
}

function buildFullscreenHtml() {
    return `
<div class="realmap_fullscreen realmap_fullscreen_native">
    <div id="realmap_map_fullscreen"></div>
    <div id="realmap_transfer_panel" class="realmap_transfer_panel" style="display:none"></div>
    <div class="realmap_fs_disable_ctl" style="display:none">
        <div id="realmap_fs_disable_btn" class="realmap_fs_disable_btn" title="禁用现实地图">禁用</div>
        <div id="realmap_fs_rejudge_btn" class="realmap_fs_rejudge_btn" title="重新判断位置">重新判断</div>
    </div>
    <div class="realmap_fs_close_ctl">
        <div id="realmap_fs_close" class="realmap_fs_close_btn" title="退出全屏 (Esc)">✕</div>
    </div>
    <div class="realmap_fs_layer_ctl">
        <select id="realmap_fs_layer_select" class="realmap_layer_select">
            <option value="normal">标准</option>
            <option value="satellite">卫星</option>
        </select>
        <div id="realmap_fs_layer_btn" class="realmap_layer_btn" style="display:none">路网</div>
        <div id="realmap_fs_panorama_btn" class="realmap_panorama_btn" title="在百度街景中打开">全景</div>
    </div>
    <div class="realmap_fs_zoom_ctl">
        <div id="realmap_fs_zoom_in" class="realmap_zoom_btn">+</div>
        <div id="realmap_fs_zoom_out" class="realmap_zoom_btn">−</div>
    </div>
    <div id="realmap_route_slider" class="realmap_route_slider" style="display:none">
        <div class="realmap_slider_option active" data-pos="0"></div>
        <div class="realmap_slider_option" data-pos="1"></div>
        <div class="realmap_slider_thumb"></div>
    </div>
    <div class="realmap_search">
        <input id="realmap_search_input" class="text_pole" placeholder="搜索地点…" autocomplete="off" />
        <div id="realmap_search_results" class="realmap_search_results"></div>
    </div>
</div>`;
}
