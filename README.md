# SillyTavern-RealMap

为[SillyTavern](https://github.com/SillyTavern/SillyTavern)角色扮演对话提供真实地理位置能力。扩展会在每轮AI回复完成后调用独立的LLM判断用户角色所在地点，再通过高德地图JS API 2.0完成地理编码、路线解析与地图展示。

> 项目仍在开发中。位置推断、地图小窗、浏览器全屏、地点搜索、路线预览、移动端悬浮球和位置上下文注入均已接入；Slash命令等功能仍在规划中。

## 功能

### 位置推断

- 监听每轮AI消息完成事件，读取上一轮位置、相关用户消息和AI正文。
- 支持OpenAI、OpenRouter、DeepSeek及自定义OpenAI兼容接口。
- 支持两类位置结果：
  - `idle`：角色停留在某个地点，经高德地理编码后保存坐标、格式化地址和周边POI摘要。
  - `moving`：角色正在移动，经高德驾车、步行、骑行或公交路线服务解析后保存起终点、距离、时长和路线折线。
- 系统提示词、assistant确认回复和user上下文模板统一由源码文件维护。
- 小窗和移动端全屏均提供“重新判断”入口。
- 推断成功后，当前位置和周边POI会作为system扩展提示词注入后续对话。

### 地图界面

- 桌面端提供默认`320×240`的可拖动小窗，窗口位置保存在`accountStorage`。
- 小窗支持地图拖动、滚轮缩放、缩放按钮、标准/卫星底图切换、卫星路网叠加和全景入口。
- 全屏使用浏览器Fullscreen API；浏览器拒绝全屏请求时，仍会使用铺满视口的界面。
- 全屏支持全国地点搜索，并结合当前位置对结果排序和显示距离。
- 地图使用红色标记当前位置、黄色标记目的地、蓝色标记当前选择。
- 点击地点后可：
  - 将步行、骑行、驾车或公交指令填入SillyTavern输入框，由用户确认发送。
  - 覆盖最近一条AI消息记录的当前位置。
  - 预览驾车、步行、骑行或公交路线。
- 驾车预览可切换“高速优先”和“不走高速”；公交预览可切换“优先地铁”和“优先公交”，并展示线路、站点、步行段、用时、距离及费用信息。
- “全景”会在新标签页打开百度地图，并通过`coord_type=gcj02`传递高德坐标。

### 移动端

- 使用可拖动的地图悬浮球代替桌面小窗。
- 悬浮球可吸附屏幕边缘，点击后进入全屏地图。
- 全屏内提供“禁用”和“重新判断”按钮。
- 公交详情以底部面板显示，路线策略切换控件会适配面板高度。

### 聊天状态与回档

- 启用状态按聊天保存在`chat_metadata.realmap_enabled`。
- 每条AI消息的位置保存在`message.extra.realmap`，并同步到当前`swipe_info[swipe_id].extra`。
- 删除消息、切换swipe和从历史楼层继续聊天时，位置会随SillyTavern原生消息状态一起变化。
- 打开带有历史位置的聊天时，扩展会从最近一条AI消息恢复地图状态。
- 禁用扩展时可选择一并清除当前聊天内的历史位置数据，聊天正文不会被改动。

## 安装

### 使用SillyTavern扩展安装器

1. 打开“SillyTavern→扩展→安装扩展”。
2. 输入仓库地址：

   ```text
   https://github.com/SHowGS/SillyTavern-RealMap
   ```

3. 完成安装后重载页面。

### 手动安装

```bash
cd public/scripts/extensions/third-party
git clone https://github.com/SHowGS/SillyTavern-RealMap.git
```

克隆完成后重载SillyTavern。

## 配置

### 1.高德地图

1. 前往[高德开放平台](https://console.amap.com/dev/key)创建应用。
2. 申请“Web端(JS API)”类型的Key及对应的安全密钥`securityJsCode`。
3. 打开“SillyTavern→扩展→现实地图→API配置”。
4. 填写Key和安全密钥，点击“测试连接”。

未配置高德Key时，桌面小窗会保留并显示配置提示；地图、地点解析和路线能力需要有效Key。

### 2.位置推断LLM

1. 选择API类型。
2. 自定义兼容接口需填写包含版本路径的Base URL，例如`https://api.example.com/v1`。
3. 填写API Key。
4. 点击“获取模型”，再选择模型。

扩展会请求以下OpenAI兼容端点：

- `GET /models`
- `POST /chat/completions`

未配置LLM API Key或模型时，不会发起位置推断请求。

### 3.提示词源码

四段提示词集中保存在`prompts.js`：

- `DEFAULT_SYSTEM_PROMPT`：system提示词
- `DEFAULT_ASSISTANT_REPLY`：assistant确认回复
- `CONTEXT_PROMPT_TEMPLATE`：user上下文模板
- `DEFAULT_ASSISTANT_PREFILL`：末尾assistant预填充，默认内容为`{`

实际请求顺序为`system→assistant→user→assistant预填充`。扩展设置页不提供提示词编辑功能，修改`prompts.js`后重载页面即可生效。旧版浏览器设置中的提示词字段会被清理，不会覆盖源码。

## 数据格式

静止位置示例：

```json
{
  "v": 2,
  "captured_at": 1750000000000,
  "mode": "idle",
  "lng": 116.397,
  "lat": 39.908,
  "label": "北京市东城区天安门",
  "poi": true,
  "nearby": "周边：天安门(北120m)"
}
```

移动状态示例：

```json
{
  "v": 2,
  "captured_at": 1750000000000,
  "mode": "moving",
  "from": {
    "lng": 116.397,
    "lat": 39.908,
    "label": "天安门"
  },
  "to": {
    "lng": 116.403,
    "lat": 39.924,
    "label": "故宫博物院"
  },
  "route_mode": "walking",
  "duration_min": 18,
  "distance": 1400,
  "polyline": []
}
```

## 隐私与行为边界

- 高德Key和LLM API Key保存在SillyTavern扩展设置中。
- 启用位置推断后，扩展会将相关对话正文、上一轮位置和源码提示词发送到所配置的LLM服务。
- 地图搜索、地理编码、周边POI和路线请求会发送到高德地图服务。
- “前往此处”仅填写输入框，不会自动发送消息。
- “设置此地为当前位置”会在确认后修改最近一条AI消息的`extra.realmap`。
- 当前版本会在每次LLM请求结束后显示调试弹窗，其中包含请求消息、原始输出或错误信息。

## 要求

- SillyTavern`>=1.12.0`
- 支持ES模块和Fullscreen API的现代浏览器
- 高德开放平台Web端JS API Key及安全密钥
- 位置推断所需的OpenAI兼容LLM端点

生产环境建议使用HTTPS，以满足地图API和浏览器全屏能力的安全要求。

## 项目结构

```text
manifest.json        # 扩展清单
settings.html        # API配置和启用控制
style.css            # 小窗、全屏、路线面板和移动端样式
index.js             # 初始化、聊天事件、LLM推断、位置解析和提示词注入
prompts.js           # system、assistant、user上下文及末尾预填充
amap.js              # 高德JS API加载与连接测试
state.js             # 聊天元数据、消息位置、窗口位置和坐标工具
minimap.js           # 桌面小窗与移动端悬浮球
fullscreen.js        # 全屏地图、搜索、地点操作和路线预览
layer-control.js     # 标准、卫星及路网图层控制
place-search.js      # 全国/附近地点搜索、候选去重和统一评分
```

## Roadmap

- [x] 按聊天启用、禁用及历史位置清理
- [x] 独立LLM位置推断
- [x] `idle`和`moving`位置解析
- [x] 位置与周边POI上下文注入
- [x] 桌面地图小窗和移动端悬浮球
- [x] 浏览器全屏地图、地点搜索和手动位置覆盖
- [x] 标准/卫星底图与路网叠加
- [x] 驾车、步行、骑行和公交路线预览
- [x] 用户搜索与LLM位置解析共用地点搜索和评分
- [ ] Slash命令
- [ ] 更完整的错误恢复与无位置状态提示
- [ ] 设置面板国际化

## License

本项目采用MIT许可证，详见[LICENSE](LICENSE)。
