// 通用图层控制器：右上角下拉菜单切换标准/卫星；卫星模式下「路网」按钮可切换高亮/灰暗。
// 调用方传入唯一 id 前缀（避免多个地图并存时 id 冲突），并把下面 HTML 放进地图容器：
//
//   <div class="realmap_layer_ctl">
//     <select id="{PREFIX}_layer_select" class="realmap_layer_select">
//       <option value="normal">标准</option>
//       <option value="satellite">卫星</option>
//     </select>
//     <div id="{PREFIX}_layer_btn" class="realmap_layer_btn" style="display:none">路网</div>
//   </div>

export function createLayerController(map, prefix) {
    const AMap = window.AMap;
    const $select = $(`#${prefix}_layer_select`);
    const $btn = $(`#${prefix}_layer_btn`);

    let baseLayer = map.getLayers().find(l => l.CLASS_NAME === 'AMap.TileLayer') || null;
    let satelliteLayer = null;
    let roadNetLayer = null;
    let mode = 'normal';        // 'normal' | 'satellite'
    let roadNetOn = false;      // 是否叠加路网

    function ensureSatellite() {
        if (!satelliteLayer) satelliteLayer = new AMap.TileLayer.Satellite();
    }
    function ensureRoadNet() {
        if (!roadNetLayer) roadNetLayer = new AMap.TileLayer.RoadNet();
    }

    // 标准：保留/还原默认底图，移除卫星与路网
    function toNormal() {
        if (satelliteLayer) { try { map.remove(satelliteLayer); } catch (_) {} }
        if (roadNetLayer) { try { map.remove(roadNetLayer); } catch (_) {} roadNetOn = false; syncRoadBtn(); }
        if (baseLayer && !map.getLayers().includes(baseLayer)) {
            try { map.add(baseLayer); } catch (_) {}
        }
        $btn.hide();
    }

    // 卫星：移除默认底图，叠加卫星；「路网」按钮出现并默认未叠加（灰暗）
    function toSatellite() {
        ensureSatellite();
        // 移除默认底图，免得压住卫星图
        const layers = map.getLayers();
        for (const l of [...layers]) {
            if (l === satelliteLayer || l === roadNetLayer) continue;
            if (l?.CLASS_NAME === 'AMap.TileLayer') {
                baseLayer = l;
                try { map.remove(l); } catch (_) {}
            }
        }
        if (!map.getLayers().includes(satelliteLayer)) {
            map.add(satelliteLayer);
        }
        $btn.show();
        // 进入卫星图默认不叠加路网（灰暗）
        if (roadNetOn) {
            ensureRoadNet();
            if (!map.getLayers().includes(roadNetLayer)) map.add(roadNetLayer);
        } else if (roadNetLayer) {
            try { map.remove(roadNetLayer); } catch (_) {}
        }
        syncRoadBtn();
    }

    function toggleRoadNet() {
        if (mode !== 'satellite') return; // 安全：只在卫星模式下有意义
        roadNetOn = !roadNetOn;
        if (roadNetOn) {
            ensureRoadNet();
            if (!map.getLayers().includes(roadNetLayer)) map.add(roadNetLayer);
        } else if (roadNetLayer) {
            try { map.remove(roadNetLayer); } catch (_) {}
        }
        syncRoadBtn();
    }

    function syncRoadBtn() {
        $btn.toggleClass('realmap_layer_btn-on', roadNetOn);
        $btn.text(roadNetOn ? '路网 ✓' : '路网');
    }

    $select.on('change', () => {
        mode = $select.val() === 'satellite' ? 'satellite' : 'normal';
        if (mode === 'normal') toNormal();
        else toSatellite();
    });

    $btn.on('click', () => toggleRoadNet());

    return {
        destroy() {
            $select.off('change');
            $btn.off('click');
            [baseLayer, satelliteLayer, roadNetLayer].forEach(l => { try { map.remove(l); } catch (_) {} });
            if (baseLayer) {
                // 还原默认底图，避免地图空了
                const layers = map.getLayers();
                if (!layers.includes(baseLayer)) map.add(baseLayer);
            }
        },
    };
}
