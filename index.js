import { extension_settings, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { t } from '../../../i18n.js';

const MODULE_NAME = 'mapservice';
const LOADER_URL = 'https://webapi.amap.com/loader.js';

/**
 * @typedef {Object} MapServiceSettings
 * @property {string} key Amap JS API key
 * @property {string} securityCode Amap securityJsCode
 * @property {string} defaultCity Default city for searches / weather
 * @property {string} mapStyle Map style id, e.g. amap://styles/dark
 * @property {boolean} injectContext Whether to inject map context into prompt
 */

const DEFAULT_SETTINGS = {
    key: '',
    securityCode: '',
    defaultCity: '北京',
    mapStyle: 'amap://styles/normal',
    injectContext: false,
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

async function openMap() {
    const AMap = await loadAmap();
    const s = ensureSettings();
    const dialog = $('<div id="mapservice_map_dialog" style="width:100%;height:600px"></div>');
    import('../../../popup.js').then(({ callGenericPopup, POPUP_TYPE }) => {
        callGenericPopup(dialog, POPUP_TYPE.TEXT, '', { wide: true, large: true, okButton: 'Close' }).finally(() => {
            map && map.destroy();
        });
        const map = new AMap.Map(dialog[0], {
            zoom: 12,
            mapStyle: s.mapStyle,
        });
        map.addControl(new AMap.Scale());
    });
}

async function testConnection() {
    try {
        const AMap = await loadAmap();
        const s = ensureSettings();
        let resolved = false;
        const district = new AMap.DistrictSearch({ level: 'city', subdistrict: 0 });
        district.search(s.defaultCity || '北京', (status, result) => {
            resolved = true;
            if (status === 'complete' && result.districtList && result.districtList.length) {
                toastr.success(t`Amap connection OK — center: ${result.districtList[0].center}`);
            } else {
                toastr.warning(t`Amap loaded but query returned no district for "${s.defaultCity}".`);
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
    $('#mapservice_key').val(s.key).on('input', function () {
        s.key = String($(this).val());
        amapPromise = null;
        saveSettingsDebounced();
    });
    $('#mapservice_security_code').val(s.securityCode).on('input', function () {
        s.securityCode = String($(this).val());
        amapPromise = null;
        saveSettingsDebounced();
    });
    $('#mapservice_default_city').val(s.defaultCity).on('input', function () {
        s.defaultCity = String($(this).val());
        saveSettingsDebounced();
    });
    $('#mapservice_map_style').val(s.mapStyle).on('change', function () {
        s.mapStyle = String($(this).val());
        saveSettingsDebounced();
    });
    $('#mapservice_inject_context').prop('checked', !!s.injectContext).on('change', function () {
        s.injectContext = !!$(this).prop('checked');
        saveSettingsDebounced();
    });
    $('#mapservice_open_map').on('click', () => void openMap());
    $('#mapservice_test_connection').on('click', () => void testConnection());
}

export async function init() {
    const settingsHtml = await renderExtensionTemplateAsync('third-party/SillyTavern-RealMap', 'settings');
    $('#extensions_settings').append(settingsHtml);
    bindSettings();
    console.debug('[MapService] initialized');
}
