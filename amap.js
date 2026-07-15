const LOADER_URL = 'https://webapi.amap.com/loader.js';

let amapPromise = null;

export function resetAmapCache() {
    amapPromise = null;
}

export async function loadAmap(key, securityCode) {
    if (!key) {
        throw new Error('未配置高德 JS API Key，请在扩展设置中填写。');
    }
    if (amapPromise) {
        return amapPromise;
    }
    amapPromise = (async () => {
        window._AMapSecurityConfig = { securityJsCode: securityCode || '' };
        if (typeof AMapLoader === 'undefined') {
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = LOADER_URL;
                script.onload = resolve;
                script.onerror = () => reject(new Error(`无法加载高德 loader：${LOADER_URL}`));
                document.head.appendChild(script);
            });
        }
        return await AMapLoader.load({
            key,
            version: '2.0',
            plugins: [
                'AMap.Scale',
                'AMap.ToolBar',
                'AMap.Geocoder',
                'AMap.AutoComplete',
                'AMap.PlaceSearch',
                'AMap.Weather',
                'AMap.Driving',
                'AMap.Walking',
                'AMap.Transfer',
                'AMap.Riding',
                'AMap.DistrictSearch',
                'AMap.Geolocation',
            ],
        });
    })();
    return amapPromise;
}

export async function testAmapConnection(key, securityCode) {
    const AMap = await loadAmap(key, securityCode);
    let container = document.getElementById('realmap_test_container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'realmap_test_container';
        container.style.cssText = 'position:fixed;left:-9999px;top:0;width:300px;height:300px;';
        document.body.appendChild(container);
    }
    return new Promise((resolve) => {
        let settled = false;
        const finish = (ok, msg) => {
            if (settled) return;
            settled = true;
            try { map.destroy(); } catch (_) {}
            resolve({ ok, msg });
        };
        const map = new AMap.Map(container, { zoom: 12 });
        map.on('complete', () => finish(true, '高德地图连接成功（key 与安全密钥有效）。'));
        map.on('error', (e) => finish(false, `高德地图加载失败：${e?.info || JSON.stringify(e)}`));
        setTimeout(() => finish(null, '高德地图已加载，但瓦片 complete 事件超时（key 可能受限）。'), 8000);
    });
}
