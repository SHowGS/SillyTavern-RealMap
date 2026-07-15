# SillyTavern-MapService

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) third-party extension that integrates the **高德地图 (Amap) JS API 2.0** to enrich roleplay with real-world geographic context — places, weather, routing, and an interactive map.

> This is the initial **framework** release. The map UI, slash commands, and prompt injection are scaffolded; the interactive feature set will land in subsequent milestones.

## Features (framework)

- Settings panel in the SillyTavern **Extensions** drawer:
  - Amap **JS API Key** and **Security Code (安全密钥)** — stored in `extension_settings`, never committed.
  - Default city, map style, and a toggle for prompt-context injection.
  - **Open Map** and **Test Connection** buttons.
- Loads the official `AMapLoader` from the 高德 CDN (`https://webapi.amap.com/loader.js`) — no build step, no npm dependency added to SillyTavern.
- Idempotent loader: repeat calls reuse the same `AMap` global.

## Installation

### Via SillyTavern's built-in installer

1. Open SillyTavern → **Extensions** → **Install extension**.
2. Enter the repository URL:
   ```
   https://github.com/SHowGS/SillyTavern-MapService
   ```
3. Reload the page and enable **现实地图**.

### Manual

Clone this repository into your SillyTavern's `public/scripts/extensions/third-party/` directory:

```bash
cd public/scripts/extensions/third-party
git clone https://github.com/SHowGS/SillyTavern-MapService.git
```

Then reload SillyTavern.

## Configuration

1. Apply for a **Web端 (JS API)** key and its **安全密钥 (securityJsCode)** at <https://console.amap.com/dev/key>.
2. In SillyTavern, open **Extensions → 现实地图**.
3. Paste your key and security code. Both are saved to your local SillyTavern settings only.
4. Click **Test Connection** to verify.

## Why JS API over Web API?

This extension prioritizes the 高德 **JS API 2.0** (browser-side loader) to avoid routing requests through a backend proxy. This keeps the extension self-contained, CORS-free for map rendering, and within the JS API quota model (billed per map session, not per request). Web API endpoints are only used where the JS API genuinely cannot serve the feature.

## Requirements

- SillyTavern client >= `1.12.0`.
- A 高德开放平台 account (free tier available).
- A browser served over HTTPS (JS API 2.0 refuses plain HTTP in production domains).

## Roadmap

- [ ] Interactive map window with POI search & markers.
- [ ] Slash commands: `/map.search`, `/map.weather`, `/map.route`, `/map.where`.
- [ ] Prompt-context injection: append current location/weather to the chat context.
- [ ] Per-character location metadata.

## License

MIT — see [LICENSE](LICENSE).
