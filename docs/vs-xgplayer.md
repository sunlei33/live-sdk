# live-sdk vs 西瓜播放器（xgplayer）对比分析

> 对比对象：`bytedance/xgplayer` @ v3.0.26（main 分支，2026-09 抓取）
> 分析维度：技术选型 / API 设计 / 工程架构 / 代码规模
> 数据来源：xgplayer 仓库源码（shallow clone，含 `packages/*/src`）、GitHub Issues、本项目 spec（`../../docs/live-sdk-spec.md`）
> 本文 live-sdk 侧数据：**2026-09-16 实测**（live-sdk `0.6.0`；统计口径见 §1.0）

**本文档定位：帮助你在两者之间做选型。** 因此只讲「差异是什么、意味着什么」，不做「谁更好」的评判——两者不是同一物种，选型应由你的业务场景决定。

## 一句话结论

| | live-sdk | xgplayer |
|---|---|---|
| **定位** | 垂直：H5 **直播**播放器 SDK，headless 内核 + 插件化 | 平台：通用 Web 播放器**全家桶**，VOD/Live/音乐/字幕/弹幕/投屏全覆盖 |
| **体量** | `src/` **35 个 `.ts`，3311 代码行**（5894 总行）；npm 包 1.2 MB / 89 文件 | 16 个包，核心包 `xgplayer` **21371 行**；npm 包 2.2 MB / 293 文件，全仓 **~5.5 万行** |
| **优势** | 架构干净、状态契约显式、职责边界清晰、可读性强 | 能力全面、久经字节亿级 DAU 打磨、协议/容器/编解码/端适配覆盖面极广 |
| **代价** | 能力域窄（无点播编排/DRM/弹幕/字幕/FLV/DASH）、端适配深度浅 | 耦合重、体积大、headless 不彻底（UI 与播放器实体强绑定）、状态模型隐式 |

**一句话选型**：

- **只需要 H5 直播、想要干净可控的内核、要自绘 UI 或跨端复用** → 选 **live-sdk**。
- **需要直播 + 点播 + 回放 + 弹幕/字幕/投屏，或要覆盖 FLV/DASH/端适配全家桶** → 选 **xgplayer**。

> 具体哪些能力是 live-sdk 的**主动边界收缩**，见 [README 能力边界](../README.md#能力边界non-goals)。

---

## 1. 技术选型对比

### 1.0 代码规模（实测基线）

**统计口径**（`2026-09-23` 实测，live-sdk `0.6.0`）：

- **代码行** = 剔除空行与注释（`//` 与 `/* */`，含块注释追踪）后的行数，比总行数更能反映真实体量；
- **总行** = 文件原始行数（含空行、注释）。与 xgplayer 的「21371 行」对比时请注意其口径未公开，
  仓库统计通常为**总行**，故两者并非严格同口径；
- live-sdk 数据由脚本逐文件扫描 `src/ test/ verify/ examples/ scripts/` 与仓库根的 6 个配置 `.ts`
  得到（扩展名 `.ts` / `.js` / `.mjs`），非估算。

**live-sdk 目录分布**：

| 目录 | 文件 | 代码行 | 总行 | 职责 |
|---|---|---|---|---|
| `src/core/` | 9 | 1409 | 2436 | Player · StateMachine · StateStore · EventBus · PluginManager · BasePlugin · Hooks · **SessionMetrics** · **QualityController** |
| `src/platform/web/` | 7 | 338 | 617 | Web 平台实现：WebMediaSurface · WebHost · selectKernel · capabilities · fullscreen · presets · dom |
| `src/`（根） | 3 | 538 | 1196 | `types.ts`（全部契约类型）· `constants.ts` · `index.ts` |
| `src/utils/` | 6 | 364 | 639 | 抽出的纯函数（可测性边界）：errors · size · config · logger · buffer · **i18n（含文案表 `MESSAGES`）**。`retry` / `features` / `quality` 已按「唯一消费者」判据归位到持有者 |
| `src/ui/` | 3 | 242 | 344 | 默认 UI 包（→ `live-sdk/ui`） |
| `src/kernel/` | 2 | 218 | 313 | HlsKernel · NativeKernel（经 `config.kernel` 注入） |
| `src/plugins/` | 2 | 128 | 232 | 随 SDK 附带、经 `preset` 装配的插件：ConsoleReporter · LivePolling |
| `src/env/` | 1 | 40 | 50 | WebEnvAdapter（经 `config.env` 注入） |
| `src/adapters/` | 2 | 34 | 67 | React / Vue（→ `live-sdk/react` · `/vue`） |
| **`src/` 小计** | **35** | **3311** | **5894** | 分发产物只含这一层 |
| `test/` | 19 | 3468 | 4278 | Vitest 单测（**15 个 .test.ts**）+ DOM 替身 + Playwright E2E |
| `verify/` | 9 | 1736 | 2542 | 契约 · 分层依赖 · 产物卫生 · 公开面形状/**成员可见性**/活性 · 事件活性 · 冒烟 |
| `examples/` | 1 | 34 | 92 | 接入方可直接复制的样板（含 reporter-sentry，被编译 + 单测保护） |
| `scripts/` | 2 | 234 | 314 | 构建清理 + 发布脚本 |
| 根配置 | 6 | 135 | 173 | vite/vitest/playwright/tsconfig 等 |
| **全仓合计** | **72** | **8918** | **13293** | |

> **目录的划分依据不是「代码归类」，而是边界**（这是 `src/` 只有 7 个目录的原因）：
>
> | 边界 | 目录 | 判据 |
> |---|---|---|
> | 随 SDK 附带、经 `preset` / `registerPlugin` 装配的**插件** | `plugins/` | 在 `preset.live` 里（`ConsoleReporter` · `LivePolling`） |
> | 经 `config.*` 注入的**可替换契约** | `kernel/` · `env/` | 由 `config.kernel` / `config.env` 指定，**不参与 Preset**（见 spec §3.1） |
> | **发布子路径的包** | `ui/` · `adapters/` | 各对应一个 npm 子入口（`live-sdk/ui` · `/react` · `/vue`） |
>
> 两个 1 文件目录（`env/` · `kernel/`）**刻意保留**：它们命名的是「SDK 拥有的一个契约位」，
> 而非某段代码的归类 —— 与「把 `reporter/` 并入 `plugins/`」不矛盾（后者 1 个成员的类别，
> 且它本身就是插件）。
>
> **值得注意的两个比例**：
>
> 1. **`src/core/Player.ts` 单文件 1042 代码行**，占 `src/` 的 **31.5%** —— 它仍是最重的「协调者」。
>    走势：1063（36.9%）→ 抽出 `SessionMetrics` / `QualityController` 降到 1004（30.4%）
>    → 消息编号化 +38 → **并入 `retry` / `features` 再 +38，到 1042（31.5%）**。
>    后两次增长都是**有意换取的**（可观测性 / 少一个 utils 模块），不是抽离失效（见 §3.2）。
>    其余 34 个文件平均 ~67 行。
> 2. **测试与验证代码（5204 行）超过 src（3311 行）**。这不是「测试写多了」，而是有意的：
>    契约层、公开面普查与冒烟都是**编译期/构建期的证明**，替代了一部分运行时验证成本。

**分发体积**（`dist/`，`minify: false`，**未压缩**）：

| 产物 | 原始 | gzip |
|---|---|---|
| `live-sdk.es.js`（核心，`hls.js` external） | 118.6 kB | **38.8 kB** |
| `live-sdk.umd.js` | 125.8 kB | 39.5 kB |
| `live-sdk-ui.es.js`（默认 UI 包） | 14.7 kB | 5.3 kB |
| `live-sdk-react.es.js` / `live-sdk-vue.es.js` | 0.3 / 0.6 kB | — |

**npm 包对比**（core 包，`files: ["dist"]`）：

| | 当前工作树 | `0.5.0`（npm 已发布） | xgplayer `3.0.26`（核心包） | 比值 |
|---|---|---|---|---|
| unpacked 体积 | 1.2 MB | 831 kB | 2.23 MB | ~1.9× |
| 文件数 | 89 | 81 | 293 | ~3.3× |
| 包数（同装一份） | 1 | 1 | 1（另需各协议/功能包） | — |

> 体积的大头不是代码而是 **sourcemap**：`dist` 内 670 kB / 1080 kB（≈62%）都是 `.map`，
> 因为 sourcemap 内嵌 `sourcesContent`（源码**原文**，含注释），且 `es` 与 `umd` 各嵌一份。
> 这是「`minify: false` + 便于接入方阅读调试」这一取向的**必然代价**，不是失误。
> 相对 0.5.0 的增长主要来自两处：P0/P1 平台解耦（新增 `src/platform/web/` 7 个文件与其声明）、
> 以及上帝对象治理（新增 `SessionMetrics` / `QualityController`），还有消息 i18n 体系（`utils/i18n` + 内含的文案表 `MESSAGES` + `LV-7xxx` UI 文案表）。
> 逐类核对过 0.5.0 → 0.6.0 的差异：`.js` / `.d.ts` / `.d.ts.map` 三类都**变小**，增量全在 `.js.map`。
>
> ⚠️ **由此引出一个应当知情的事实**：`files: ["dist"]` 会把 `.js.map` 一起发布，而 map 里含
> `sourcesContent` —— 即**接入方从 npm 包就能读到 `src/` 的完整源码与注释原文**
> （主包 map 内嵌约 263 kB）。这与本文档「`minify: false`，便于接入方阅读与调试」的既定取向一致，
> 故按**有意设计**处理；若希望只公开构建产物，需另行决定是否剥离 `sourcesContent`。

> ⚠️ **体积对比的注意事项**：live-sdk 构建配置是 `minify: false`（便于接入方阅读与调试，
> 压缩交给使用方的打包器），因此上表的 118.6 kB **不是压缩后的对外体积**；gzip 后 38.8 kB 才是
> 更接近实际的传输量。xgplayer 的 `dist` 则是压缩产物。**两者不可直接比大小**，
> 上表只用于说明量级差异。

### 1.1 总览

| 维度 | live-sdk | xgplayer | 评价 |
|---|---|---|---|
| **协议** | 仅 **HLS**（单协议） | HLS / **FLV** / DASH / MP4（渐进式）/ WebSocket-MP4，均有独立内核包 | xgplayer 覆盖广；live-sdk 以「单协议做深」换架构简洁 |
| **容器** | **fMP4**（CMAF），走 LL-HLS `EXT-X-PART` | 自研 demux/remux（TS/fMP4/FLV 全支持） | xgplayer 自研 `xgplayer-transmuxer`（8633 行）——代价是维护面巨大 |
| **播放内核** | **hls.js**（npm 锁版本，业界成熟库） | **自研**（hls/flv/dash 三套内核 + 共享 `streaming-shared`） | 两条路线：借力成熟库 vs 自研可控。自研换来 LL-HLS 精细调优能力，也带来大量内核级 issue |
| **UI 架构** | **Headless**：内核不创建可见 DOM，只暴露「状态/命令/事件」三契约 | **UI 内建**：`Player extends MediaProxy`，控件以插件形式挂在播放器实体上 | live-sdk 更适合自绘/多端复用；xgplayer UI 开箱即用但难剥离 |
| **状态模型** | **显式状态机**：`idle→loading→ready→playing→paused→stalled→error→ended`，表驱动 | **状态常量 + class 名**：`INITIAL/READY/ATTACHING/ATTACHED/NOTALLOW/RUNNING/ENDED/DESTROYED`，靠 `addClass/removeClass` 驱动 | live-sdk 的状态可枚举、可断言；xgplayer 的状态与 DOM class 耦合 |
| **点播支持** | ⚠️ **仅 HLS 有限时长流**（重播 / 点播回放，内核报 `isLive=false`）；**不支持**渐进式 `.mp4`、`playNext`、播放列表编排 | ✅ 一等公民（`isLive=false`、`seek`、`replay`、`playNext`、渐进式 MP4） | **用户明确举例的技术选型差异**，详见 §1.2 |
| **时间轴操作** | ⚠️ `seek` / `setPlaybackRate` **在契约内，但受限于有限时长**（0.3.0 起）：直播下 `seek` 为 **noop**、倍速**不建议使用** | ✅ 一等公民（`seek` + 倍速面板）；直播下另有「动态倍速纠偏」对齐延迟 | 判据是**内核报的 `isLive`**（0.6.0 起），而非「有没有这条命令」，也**不是** `duration` 是否有限（MSE 直播流的 `duration` 是有限的 playlist edge，见 §1.2）。xgplayer 的直播倍速是**内部纠偏手段**（微调追平 live edge），不是给用户的操作；live-sdk 的纠偏交给 hls.js 的 `targetLatency` |
| **DRM** | ❌ 划出边界（`client='absent'`） | ⚠️ `ErrorTypes.drm` 预留，另有 `xgplayer-shaka` 包承接 | 两者都非强项，但 xgplayer 有扩展位 |
| **低延迟** | LL-HLS（fMP4）+ `targetLatency`/`maxLatency` 透传 hls.js | 自研 LL-HLS（`useLowLatency`、`targetLatency`、`mseLowLatency`、`preferMMS`）+ gap jump + 动态倍速纠偏 | xgplayer 更细（自研可控）；live-sdk 依赖 hls.js 实现 |
| **端回退** | `NativeKernel`（Safari 原生 HLS） | MSE→native 自动降级、MMS（iOS ManagedMediaSource）、AirPlay/Cast（`xgplayer-cast`） | xgplayer 端适配深度远超 live-sdk |
| **解码** | 交给浏览器 | 软/硬解切换（`softDecode`）、H.265 软解回退、G.711 音频补齐 | 自研内核才能做到；live-sdk 受限于浏览器能力 |
| **语言/构建** | **TypeScript** + Vite + esbuild | **JavaScript**（JSDoc 类型）+ 自研 `libd` 构建（rollup/babel） | live-sdk 类型即文档；xgplayer ESLint/Biome + JSDoc |

### 1.2 「不支持渐进式点播」是技术选型差异——但不是缺陷

用户特别点出「例如不支持点播模式」。需要精确区分：

| | 结论 |
|---|---|
| **事实** | live-sdk spec §1.3 明确将「渐进式点播文件（普通 `.mp4`）」列为 Non-Goal；点播场景**仅**支持 HLS 点播流（`isLive=false` 语义） |
| **性质** | 这是**主动的边界收缩**，不是能力缺失的 bug |
| **根源** | ① 定位为「直播 SDK」；② 选型 hls.js 单引擎，不做渐进式 MP4 的 range 请求/分片加载；③ fMP4 容器与「完整 MP4 文件」是两回事（spec 已澄清） |
| **后果** | ✅ 架构更瘦、状态机更简（无 seek/replay/playNext 的 VOD 分支）；⚠️ 若业务需要「直播 + 回放 + 点播短视频」一体，必须再挂一个 VOD 内核或换库 |
| **xgplayer 反证** | xgplayer 的 `xgplayer-mp4` / `xgplayer-mp4-new` / `xgplayer-mp4-loader`（合计 ~3600 行）专为渐进式 MP4，且**恰是 issue 重灾区**（#1910/#1911/#1872/#1830：大文件 OOM、引入后无法播放、拖拽报错）——说明 VOD 不是「顺手支持」的，是实打实的复杂度成本 |

> **建议（已采纳）**：spec 现在给出的是「**技术选型的显式代价**」口径，而非「暂不做」——
> 判据写成「**时间轴此刻可不可控**」，由**内核**回答（`Kernel.isLive`，0.6.0 起；见 spec §3.2）。

> **边界澄清（0.3.0 起）**：live-sdk 把 `currentTime` / `duration` 放进状态快照，并提供
> `seek` / `setPlaybackRate` 两条命令，但**语义被约束在「有限时长」**：
>
> | | 直播（内核 `isLive=true`） | 点播 / 重播（内核 `isLive=false`） |
> |---|---|---|
> | `seek(t)` | **noop**（调用不生效、不抛错） | 正常定位 |
> | `setPlaybackRate(r)` | 不拦截，但**不建议使用**（变速持续累积/消耗延迟） | 正常用法 |
> | `requestFullscreen` / 其余命令 | 同样适用 | 同样适用 |
>
> 因此**不要因为「有 `currentTime` / `duration` 了」就以为可以画可拖拽进度条**：直播时间轴受
> live edge 约束，拖拽无意义（`seek` 会被判定为 no-op，`COMMAND` 事件的 `applied` 会如实回报 `false`）。
> ⚠️ 尤其**不要用 `duration` 是否有限来判定「能不能拖」** —— MSE 路径下 hls.js 会把直播流的
> `duration` 写成有限的 playlist edge（`liveDurationInfinity` 默认 `false`），据此判定会误判。
> 渐进式 `.mp4`（真正的 VOD）仍是 Non-Goal。

### 1.3 选型差异导致的 issue 类型对照

| issue 主题 | xgplayer 是否遇到 | live-sdk 是否可能遇到 | 说明 |
|---|---|---|---|
| 自研 demux 解析异常（HEVC/异常流） | ✅ 高频（#1897 H265 只播最后片段、#1845 mkv 音轨） | ❌ 不太可能 | hls.js 承担了 demux，风险外包给成熟库 |
| MSE 生命周期管理（object URL 泄漏） | ✅ #1945（unbind 早于 sourceopen 时 URL 未 revoke） | ⚠️ **可能**（已修复） | hls.js 内部管理，但 `destroy()`/`switchURL()` 的 blob 源释放需自查 |
| 渐进式 MP4 大文件 OOM | ✅ #1910 #1911 | ❌ 不适用（不支持点播） | 选型差异 → 风险天然规避 |
| 软/硬解与编解码兼容 | ✅ #1865 H265 无硬解无法播、#1854 G711 无声 | ⚠️ 依赖浏览器，无自解能力 | live-sdk 无解码栈，能力上限即浏览器上限 |
| LL-HLS 精细调优 | ✅ 自研可控（`mseLowLatency` 等） | ⚠️ 受 hls.js 配置面约束 | 选型差异：可控性 vs 稳定性 |

---

## 2. API 设计对比

### 2.1 初始化与调用风格

| | live-sdk | xgplayer |
|---|---|---|
| **初始化** | `createPlayer({ container, url, kernel, preset, hlsConfig })` —— 工厂函数，显式注入内核 | `new Player({ id, url, ... })` —— 类构造，内核由 `presets`/`ignores` 隐式决定 |
| **内核选择** | 显式：`kernel: HlsKernel`，缺省按平台能力自动选 | 隐式：靠引入哪个插件包（`xgplayer-hls` / `xgplayer-flv`）自动注册 |
| **UI** | 完全外置（`live-sdk/ui` 独立包），可不用 | 内建，`preset` 决定挂哪些控件 |
| **命令** | **12 条**：`play(config?)` / `pause()` / `mute()` / `setVolume()` / `switchQuality(id)` / `switchURL(url)` / `requestFullscreen(target?)` / `exitFullscreen()` / `seek(t)` / `setPlaybackRate(r)` / `setPoster()` / `setLiveLatency()`。另有 `setAppState()` / `report()` / `registerPlugin()` / `useHooks()` | `play()` / `pause()` / `seek()` / `switchUrl()` / `switchDefinition()` / `retry()` / `replay()` / `playNext()` / `destroy()` 等（含 VOD 专属命令） |
| **状态查询** | `getState()` 返回快照对象（`playing` / `currentTime` / `duration` 等语义字段） | 直接读实例属性（`player.paused` / `player.currentTime`），状态散落 |
| **事件** | 统一点分号常量，`on/off/once`，含语义化事件（`first_frame`/`stalled`/`recovered`/`retry`/`live_status`） | 常量导出（`Events.PLAY` 等），**大量底层 media 事件直接透传**（`waiting`/`seeking`/`canplay`…） |
| **插件** | `registerPlugin/unregisterPlugin` + `BasePlugin` 生命周期；注册入参**构造器或实例皆可** | `BasePlugin` + `Plugin` + `presets` + `ignores`，生态更成熟 |
| **封面图** | `poster` + `posterMode: 'native' \| 'overlay'`（MSE 路径可用 DOM 图层） | 内建 poster，与自研 UI 强耦合 |
| **Hooks** | `useHooks(name, fn)` | `useHooks` / `usePluginHooks` / `runHooks`（粒度更细，但 #1773 报过 hook 报错） |
| **扩展配置** | `hlsConfig` 透传（escape hatch） | 直接展开进 options，配置项数百个（文档不全，#1867 抱怨过） |

### 2.2 优势对照

| 维度 | live-sdk 更优 | xgplayer 更优 |
|---|---|---|
| **API 一致性** | ✅ 命令/状态/事件三契约统一，`getState()` 单一真源 | ❌ 状态散落实例属性，部分靠 DOM class |
| **异常可观测** | ✅ 统一 `ERROR_CODE`（13 个）+ **错误域 `err.domain`**（`network`/`decode`/`config`/`unknown`，接入方不必自建映射表）+ 内核 details 归一（大小写不敏感、404 取 HTTP 状态码）+ 重试诊断快照（地址 / 网络 / 第几次） | ⚠️ 错误码与底层 details 混合暴露，接入方需自行分类与拼装上下文；无「归因方向」这一层 |
| **语义清晰度** | ✅ `playIntent` 等业务语义显式建模 | ⚠️ 语义隐含在 `paused`/`ended` 属性 |
| **上手成本** | ✅ 配置项少、文档聚焦 | ⚠️ 配置项极多，文档滞后于源码 |
| **生态/示例** | ⚠️ 无官方文档站（有 `examples/` + 参考文档）；消息与**内置 UI 文案**支持 `en` · `zh` 两种（`locale` 配置，默认 `en`） | ✅ 官方文档站、大量 fixtures demo、多语言 i18n（15 种语言，含 UI 文案） |
| **能力完备** | ❌ 无弹幕/字幕/投屏/截图/画中画等 | ✅ 全都有现成插件 |
| **二次开发** | ✅ headless，易对接自绘 UI / RN / 小程序 | ⚠️ UI 内建，深度定制需绕开内建控件 |

### 2.3 关键 API 设计差异：状态呈现（重连期「按钮态与真实状态错位」的根因）

| | live-sdk | xgplayer |
|---|---|---|
| **状态载体** | `getState().playing` 语义快照 + `SessionState` 状态机 | 读 `media.paused` 等原生属性 + 状态 class |
| **断流重连时按钮语义** | **显式建模 `playIntent`**：重连中 `playing` 保持 true，用户暂停被尊重 | 无此概念；靠 `mediaPlay()` 在 `CANPLAY` 后重播（`retry()` 实现见源码），按钮态与真实缓冲态易错位 |
| **风险** | 需自己维护意图与媒体态的同步（已由 **117 项冒烟断言 + 178 项单测**覆盖） | #1837 实测「播放/暂停反复切换」——正是重连期状态呈现失控的典型症状 |

> xgplayer `retry()` 实现：
> ```js
> retry () {
>   this.removeClass(STATE_CLASS.ERROR); this.addClass(STATE_CLASS.LOADING)
>   runHooks(this, 'retry', () => {
>     const cur = this.currentTime
>     const { url } = this.config
>     this.src = !Util.isMSE(this.media) ? this.preProcessUrl(url).url : url
>     !this.config.isLive && (this.currentTime = cur)
>     this.once(Events.CANPLAY, () => { this.mediaPlay() })   // ← 只等 CANPLAY，不还原「意图」
>   })
> }
> ```
> 无 `playIntent` 概念：重试成功后**无条件** `mediaPlay()`——若用户重连期间按了暂停，会被强行续播（与 live-sdk 修复前的隐患同源，但方向相反）。

### 2.4 关键 API 设计差异：可观测性的「契约化程度」

两者都提供错误上报与埋点，但**是否把观测数据做成契约**差别很大。这一节记录 live-sdk 侧的三层设计，
以及它替接入方省掉的工作量（数据来自真实接入实测）。

| 观测诉求 | live-sdk 的做法 | 典型的「自行拼装」做法 | 省掉的接入代码 |
|---|---|---|---|
| **错误归因** | `err.domain` ∈ `network` / `decode` / `config` / `unknown`，SDK 维护映射 | 接入方维护「错误码 Set × 2 + message 关键词兜底」 | 实测某业务 **120+ 行**，且新增错误码必然漏同步 |
| **用户操作** | `Events.COMMAND`：`{ name, phase, applied, time }` 覆盖全部 12 个命令 | 逐命令订阅语义事件 + 各自兜底 | 实测该业务 **12 组订阅 + 手动 `report()`** |
| **接入自检** | 容器零尺寸时 `play()` 告警一次（含修复提示） | 无——靠肉眼排查「为什么一片空白」 | 难以量化，但是**最高频的接入问题** |

**设计要点**（也是与 xgplayer 的差异所在）：

- **错误域是「归因方向」而非「分类树」**：四档的判据是「**谁能修**」——服务端/CDN、内容/转码、
  接入方配置。`unknown` 独立成一档且**不猜测**（不并进 `decode`），否则真实未知故障会被伪装成解码问题。
  SDK 侧有契约测试遍历全量 `ERROR_CODE`，未登记域即失败——保证接入方**不会收到「本该有域却是 unknown」**。
- **`COMMAND` 把「用户意图」与「UI 语义」分开**：语义事件（`play` / `quality_change` / …）是为驱动 UI
  设计的、载荷各异；观测只关心「点了什么、有没有生效」。`applied === false` 表示**命令返回了但没生效**
  （如 `seek` 在直播无限流下、被 before 钩子拦截）——**这不是错误**，不该记进错误看板。
- **自检消息要带修复动作**：零尺寸告警直接给出 `style="width:100%;height:300px"` 示例，
  而不是只说「尺寸为 0」。同时**只在 `play()` 时检查**（构造时容器合法为 0 的场景太多，会误报）、
  **测不到尺寸时静默**（DOM 替身/SSR 不误报）。

> **选型含义**：如果你的看板需要按「服务端 / 内容 / 接入」三分归因，或者需要统计用户交互行为，
> live-sdk 已经把这一层做成契约，接上即可用；xgplayer 侧则需要自己在 `ERROR_CODE` 之外再写一层映射。

---


## 3. 工程架构对比

### 3.1 仓库与包结构

| | live-sdk | xgplayer |
|---|---|---|
| **仓库形态** | 单包（`live-sdk/`），内部按 `src/{core,kernel,ui,adapters,plugins,reporter,env,utils}` 分层 | **Yarn workspaces monorepo**，`packages/*` 16 个独立发布包 |
| **包数量** | 1 个 npm 包（多入口：`.` / `./ui` / `./react` / `./vue`） | 16 个包，独立版本、独立发布 |
| **分层** | `src/` 下 8 个目录：core / **platform(web)** / kernel / env / plugins / ui / adapters / utils。**core 是平台无关层**（不依赖任何实现），平台实现集中于 `platform/web/` —— 由 `verify/layers.mjs` 强制（见 spec §3.9） | core(`xgplayer`) / 各协议内核 / `streaming-shared` / `transmuxer` / 功能插件包 |
| **构建** | Vite + esbuild + tsc（声明文件），ESM + UMD，**`minify: false`**（可读性优先，压缩交给使用方打包器） | 自研 `libd` CLI（rollup + babel + dts-bundle-generator），ESM + UMD + legacy |
| **类型** | 原生 TypeScript | JavaScript + JSDoc（`tsconfig` 仅做检查） |
| **Lint** | **未引入 ESLint / Prettier**（有意）——静态保障由 **`verify/` 九道质量门**承担：类型契约 · 示例编译 · 分层依赖 · 产物卫生 · 公开面形状 · **成员可见性** · 公开面活性 · 事件活性 · 冒烟。它们覆盖「契约形状 / 跨层越界 / 产物卫生 / 成员可见性 / 活性」，**不覆盖代码风格** | Biome + husky + lint-staged |
| **测试** | 四层：Vitest 单测 **264 例 / 15 文件** → `verify/` 九道门（冒烟含 **127 断言**）→ Playwright E2E **18 例**（chromium + webkit） | **Jest**（jsdom），55 个 `.spec.js`，覆盖 hls/flv/dash/transmuxer/cast/subtitles |
| **发布** | 语义化版本，**公开 npm `@fancaf/live-sdk`**；`files: ["dist"]` 白名单（源码与 docs 不随包发出） | 语义化版本，npm 公开发布，含 prerelease 流程 |
| **体积** | `src/` **3311 代码行 / 5894 总行**；npm 包 1.2 MB / 89 文件（核心 gzip 38.8 kB） | 核心包单包即 21371 行 / npm 包 2.23 MB / 293 文件，全仓 ~5.5 万行 |

### 3.2 架构优劣

| 维度 | live-sdk | xgplayer |
|---|---|---|
| **职责边界** | ✅ 三契约（状态/命令/事件）清晰，headless 彻底 | ⚠️ UI 与播放器实体耦合（`Player extends MediaProxy`，控件即插件） |
| **可测试性** | ✅ 状态机可单测全路径；纯函数抽到 `utils/`（可测性边界）；契约/活性/冒烟三层编译期与构建期证明 | ✅ 有 Jest 体系，但状态散落、媒体依赖 mock 重 |
| **可扩展性** | ✅ 内核可插拔（协议无关），插件化 | ✅ 插件生态成熟（弹幕/字幕/投屏/音乐…） |
| **维护面** | ✅ 小（`src/` 3311 代码行，35 文件）；**单文件 `Player.ts` 1042 行占 31.5%**（1063 → 抽离后 1004 → 编号化与本轮并入后 1042），仍是最大可读性债务（见下） | ⚠️ 大（5.5 万行 + 16 包），issue 积压（大量 Stale） |
| **生态成熟度** | ❌ 从零起盘 | ✅ 字节亿级 DAU 验证，文档站 + fixtures demo |
| **端适配深度** | ⚠️ 仅 Web + Safari 回退 | ✅ iOS/Android WebView/大屏/TV/微信/投屏全覆盖 |
| **可观测性** | ✅ 内建 `Reporter`（Console/Sentry）+ **错误域 `err.domain`** + `RetryDiagnostic` + `getStats()` / `getSessionReport()` + **`COMMAND` 命令观测** | ⚠️ 有 `stats`/`logger`/`fpsDetect` 插件，但无统一上报契约，错误无归因层 |

> **live-sdk 自己最大的技术债：`core/Player.ts` 单文件 1042 代码行（占 `src/` 31.5%）。**
> 它承担装配、生命周期、状态同步、重连编排、命令实现、观测出口等全部职责，是典型的「上帝对象」。
> 评估（字段—方法引用矩阵）给出的结论是**半合理**：10 个字段构成**共享骨干**（被 7~22 个方法使用），
> 那是真耦合、拆不动；但另有 30 个字段各被 ≤5 个方法引用且成簇，属可抽的功能堆积。
> 已抽出两块（`SessionMetrics` 7 字段 / `QualityController` 2 字段），`Player` 由 1063 → 1004 代码行。
> 其后两次回升都**记录在案、且都不是抽离失效**：① 消息编号化把裸文案换成 `t(MSG.…, {…})`（**可观测性**换来的字符量）；
> ② 按「减少 `utils/` 碎片」的要求并入 `retry` / `features`（模块 −3，`Player` +38 —— 明确的取舍，见 `implementation.md` §8.22）。
> 仍待处理的见下（`play()` 已拆三相）。
> 抽取策略的另一个观察：`utils/` 那批**纯函数抽取从未让它变小**（769 → 840 → 963 → 1105 单调增长），
> **只有搬走状态所有权才真的降行数** —— 这解释了为什么早期抽取没止住增长。
> 对照 xgplayer 的教训（§3.3：自研栈 8633 行的 `transmuxer` 成为维护负担），
> **这是需要在下一阶段主动处理的**，而不是等它长到失控。

### 3.3 xgplayer 的工程债（对 live-sdk 的警示）

| 现象 | 证据 | live-sdk 应避免 |
|---|---|---|
| **issue 积压 + Stale 化** | 大量 issue 被标 `Stale`/`need info` 后关闭（#1873/#1865/#1849/#1820…） | 建立明确的「问题响应 SLA」，避免「无人跟进型关闭」 |
| **文档滞后源码** | #1867：`mobile` 插件有 `miniYPer`/`closedbClick` 等配置项但文档没有 | 文档与源码同仓、CI 校验配置项导出 |
| **配置项爆炸** | 数百个 options，`ignores`/`presets` 组合复杂 | 保持配置面收敛，用 `hlsConfig` escape hatch 而非无限加参数 |
| **包间耦合/循环** | #1813：注销 flv 插件后注册 hls 无效（内核注册状态管理问题） | 内核用显式注入（`kernel: HlsKernel`），而非全局注册表 |
| **自研栈维护成本** | `transmuxer` 8633 行、三套内核并行 | live-sdk 借力 hls.js 是把这层成本外包，需持续跟踪上游版本（#1861 chromium140 需升 hls.js） |

---

