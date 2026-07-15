import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { t } from '../../../i18n.js';

const MODULE_NAME = 'realmap';
const LOADER_URL = 'https://webapi.amap.com/loader.js';

/**
 * @typedef {Object} RealMapSettings
 * @property {string} key Amap JS API key
 * @property {string} securityCode Amap securityJsCode
 */

const DEFAULT_SETTINGS = {
    key: '',
    securityCode: '',
};

function ensureSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    extension_settings[MODULE_NAME] = Object.assign({}, DEFAULT_SETTINGS, extension_settings[MODULE_NAME]);
    return extension_settings[MODULE_NAME];
}

let amapPromise = null;

async function loadAmap() {
    const s = ensureSettings();
    if (!s.key) {
        throw new Error(t`Amap key is not configured. Open the Map Service settings and paste your JS API key.`);
    }
    if (amapPromise) {
        return amapPromise;
    }
    amapPromise = (async () => {
        window._AMapSecurityConfig = { securityJsCode: s.securityCode };
        if (typeof AMapLoader === 'undefined') {
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = LOADER_URL;
                script.onload = resolve;
                script.onerror = () => reject(new Error(t`Failed to load AMap loader from ${LOADER_URL}`));
                document.head.appendChild(script);
            });
        }
        return await AMapLoader.load({
            key: s.key,
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

async function testConnection() {
    try {
        const AMap = await loadAmap();
        let resolved = false;
        const district = new AMap.DistrictSearch({ level: 'city', subdistrict: 0 });
        district.search('北京', (status, result) => {
            resolved = true;
            if (status === 'complete' && result.districtList && result.districtList.length) {
                toastr.success(t`Amap connection OK — center: ${result.districtList[0].center}`);
            } else {
                toastr.warning(t`Amap loaded but query returned no district.`);
            }
        });
        setTimeout(() => {
            if (!resolved) toastr.info(t`Amap loaded; query still pending.`);
        }, 5000);
    } catch (e) {
        toastr.error(String(t`Amap connection failed: `) + e.message);
    }
}

function bindSettings() {
    const s = ensureSettings();
    $('#realmap_key').val(s.key).on('input', function () {
        s.key = String($(this).val());
        amapPromise = null;
        saveSettingsDebounced();
    });
    $('#realmap_security_code').val(s.securityCode).on('input', function () {
        s.securityCode = String($(this).val());
        amapPromise = null;
        saveSettingsDebounced();
    });
    $('#realmap_test_connection').on('click', () => void testConnection());
}

export async function init() {
    const settingsHtml = await renderExtensionTemplateAsync('third-party/SillyTavern-RealMap', 'settings');
    $('#extensions_settings').append(settingsHtml);
    bindSettings();
    console.debug('[realmap] initialized');
}
