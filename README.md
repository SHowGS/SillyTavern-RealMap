# SillyTavern-RealMap

为 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 角色扮演注入真实地理位置的第三方扩展。核心是接入 **高德地图 JS API 2.0**，在每一轮 AI 回复结束时由插件 LLM 推断用户角色当前所处的位置并落库，让对话拥有可回溯的地理轨迹，并以可拖动小窗 + 全屏两种形态呈现地图。

> 仓库正在开发中：前端框架、设置面板与位置推断状态机已落地；插件 LLM 推断链路、提示词集成、Slash 命令等在后续版本中完善。

## 功能概览

### 设置面板（扩展抽屉中）
- **双 Tab**：API 配置 / 提示词配置。
- **API 配置**
  - 高德 JS API Key 与安全密钥（`securityJsCode`）。
  - **测试连接** 按钮，用真实 `AMap.Map` 实例加载瓦片验证 key 与密钥有效性。
  - 插件 LLM 配置：API 类型（OpenAI / OpenRouter / DeepSeek / 自定义 OpenAI 兼容）、Base URL、API Key。
  - 模型下拉框 + **获取模型** 按钮（调 `/v1/models` 拉取）。
- **提示词配置**
  - 系统提示词、追加约束、输出 JSON 格式、工具说明（预留）、null 用户话术 五段可编辑。
  - **恢复默认** 按钮一键回写所有默认值。
  - 空即空：用户清空字段即发送空；默认值仅靠「恢复默认」写回。
- 拓展页顶部「**启用现实地图**」按钮：仅当有聊天打开时显示，已启用时变灰不可点。

### 前端地图
- **小窗**：默认右下角 320×180，16:9 地图容器，可拖动，位置记忆（存 `accountStorage`，与 SillyTavern 的"移动 UI"开关无关）。
  - 小窗状态禁用鼠标滚轮与地图拖动，仅右下角 +/− 单级缩放。
  - 右上角「禁用」文字按钮：hover 红色，点击弹确认 + 「同时清除本聊天的历史地图数据」勾选。
  - 点击地图容器切换全屏。
- **全屏**：基于 SillyTavern `Popup.show` 的原生模态，覆盖所有 UI。
  - 支持滚轮缩放、地图拖动。
  - 右下角 +/− 按钮。
  - 下方居中搜索框，结果向上展开列表；点列表项定位并放虚线 marker。
  - 三类 marker 可同时存在、同类最多一个：红色 = user 位置，黄色 = 目的地，虚线 = 选中位置。
  - 点击地图放虚线 marker，紧贴旁边弹下拉菜单：「前往此处」（仅填充输入框，由用户手动发送）/「设为当前位置」（弹确认覆盖最后一轮 AI 消息的 `extra.realmap`）。

### 位置数据与回档
- 位置数据落在**每条 AI 消息的 `extra.realmap`** 上（不额外维护 chat-level 索引）。
- 删消息 / swipe 切换等 SillyTavern 原生操作天然对齐位置数据；"从第 N 楼重开"等任何回档方式都自动生效，扩展不自建回档系统。
- 写入时同步到 `swipe_info[swipe_id].extra` 防止 swipe 切换丢失。
- 全屏手动覆盖位置会落库到最近一条 AI 消息。

### 位置推断流程（规划中，当前为 stub）
1. `CHARACTER_MESSAGE_RENDERED`（makeLast）触发。
2. 收集上一轮与本轮的 user/AI 正文、上一轮 `extra.realmap`（仅作证据）。
3. 调插件 LLM 输出 JSON：`idle` / `moving` / `null`。
4. 非空时调高德 `PlaceSearch` + `Geocoder`（idle）/ `Driving | Walking | Riding | Transfer`（moving）转换为坐标。
5. 坐标写入本轮 AI 消息 `extra.realmap` 并同步 swipe。
6. null 时：弹 toastr 报错；上一轮有位置则沿用并标 `degraded`，长期保存；上一轮无则留空，等待用户手动设置。
7. 插件 LLM **每轮无状态独立判断**，上一轮位置只是输入证据而非状态。

### 不影响正文的设计底线
- 除「设为当前位置」显式覆盖外，前端任何操作**不直接调用 LLM**。
- 所有高德调用仅服务于前端显示，不写正文。
- 「前往此处」等影响正文的动作**只通过输入框注入提示词**，由用户手动发送后交给插件 LLM 在常规流程中处理。

## 安装

### 通过 SillyTavern 内置安装器
1. SillyTavern → 扩展 → 安装扩展。
2. 输入仓库 URL：
   ```
   https://github.com/SHowGS/SillyTavern-RealMap
   ```
3. 重载页面后启用 **现实地图**。

### 手动克隆
```bash
cd public/scripts/extensions/third-party
git clone https://github.com/SHowGS/SillyTavern-RealMap.git
```
重载 SillyTavern。

## 配置

1. 在 <https://console.amap.com/dev/key> 申请 **Web端 JS API** 类型的 Key 与对应 **安全密钥**。
2. SillyTavern → 扩展 → 现实地图 → API 配置 tab。
3. 填入高德 Key 与安全密钥（仅存本机 SillyTavern 设置，不进仓库）。
4. 点击「测试连接」验证。
5. 填入插件 LLM 配置（API 类型、Key、模型可点「获取模型」拉取）。
6. 提示词配置 tab 可按需修改推断提示词，留空即发送空。

## 为什么优先 JS API

本扩展优先使用高德 **JS API 2.0**（浏览器端 loader），避免自建后端代理与 CORS 的繁文缛节，自洽分发，计费按地图会话而非请求。Web API 仅在 JS API 不足时纳入考量。

## 要求

- SillyTavern 客户端 >= `1.12.0`。
- 高德开放平台账号（有免费额度）。
- HTTPS 浏览器环境（JS API 2.0 在生产域名拒绝明文 HTTP）。
- 一个 OpenAI 兼容的插件 LLM 端点（用于位置推断；后续阶段接入）。

## 模块结构

```
manifest.json
settings.html        # 双 tab 设置面板 + 启用按钮
style.css            # 小窗 / 全屏 / 菜单 / 搜索结果样式
index.js             # 入口：设置绑定、chat_changed 钩子、enable 询问、禁用弹窗
amap.js              # 高德 loader 共享 + 测试连接
state.js             # chat_metadata 读写、accountStorage 位置记忆、可见消息与最后 AI 消息工具、历史清除
minimap.js           # 16:9 小窗：拖动 / 缩放 / 全屏入口 / 禁用回调
fullscreen.js        # Popup.show 全屏：搜索 / 点击 marker / 菜单 / 覆盖位置
```

## Roadmap

- [x] 设置面板（双 tab：API / 提示词）+ 提示词五段控件 + 恢复默认。
- [x] 前端小窗 + 全屏 + enable 状态机 + 拓展页启用按钮。
- [x] full map markers、搜索、覆盖当前位置。
- [ ] 插件 LLM 推断链路接入（当前为 stub：仅沿用上轮位置）。
- [ ] idle/moving 两种 JSON 动作的高德转换。
- [ ] Slash 命令：`/realmap.set`、`/realmap.retry`、`/realmap.clear`。
- [ ] 提示词自动注入（基于本轮位置）。

## License

MIT — 见 [LICENSE](LICENSE)。
