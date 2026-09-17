# live-sdk 用户故事（验收用例）

本文档基于 live-sdk 的公开 API 能力编写，供专业测试人员逐条验收。每条用例采用统一格式：

- **目标**：这条用例要验证什么能力
- **配置**：`createPlayer` 的初始化配置（含容器、内核、观测档位等）
- **交互**：测试人员的操作步骤
- **预期**：可观测、可断言的验收标准

> 约定：`player` 指 `createPlayer()` 返回的实例；「三契约」指状态（`getState`/`subscribe`）、命令（`play`/`pause`/…）、事件（`on`/`emit`）。所有断言均可通过浏览器控制台或自动化脚本读取。

---

## 一、基础起播

### US-01 最小可用起播（纯 H5 + 默认 UI）

- **目标**：接入方用最少代码获得一个能播、带默认控件的播放器。
- **配置**：
  ```js
  const player = createPlayer({
    container: '#player',
    url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
    autoplay: true,
    muted: true,
  })
  mountDefaultUI(player)
  ```
- **交互**：打开页面 → 等待 3s → 观察容器。
- **预期**：
  1. `container` 内出现 `<video>` 元素（由内核创建，非接入方）。
  2. 默认控件层挂载，含播放/暂停、静音、音量、清晰度、全屏五类控件。
  3. `video.readyState >= 3`，`video.paused === false`，`video.error == null`。
  4. `video.src` 为 `blob:` 开头（证明走 MSE 而非原生直连）。

### US-02 默认配置在无 MSE 平台（Safari < 17.1）仍可播

- **目标**：默认配置在旧 iOS 上不黑屏报错，而是降级为原生播放（spec §7.1 前置依赖）。
- **配置**：同 US-01（不显式传 `kernel`、`observability`）。
- **交互**：在 iOS 16 Safari 打开页面。
- **预期**：
  1. 播放器**能播**（不进入 error 态），走 `NativeKernel`。
  2. `player.getState().capabilities.stats === 'basic'`（深度观测自动落到 basic）。
  3. `capabilities.qualitySwitch === false`（原生回退不支持手动切档）。
  4. 不抛未捕获异常，控制台无 `unhandledrejection`。

### US-03 音量控制（音量滑块 / setVolume / mute 联动）

- **目标**：默认 UI 提供音量调节，且与静音状态联动一致。
- **配置**：默认 UI 包（`mountDefaultUI`）。
- **交互**：
  1. 拖动音量滑块到 50%。
  2. 点击静音按钮 → 再拖动滑块。
- **预期**：
  1. 滑块拖动后 `player.getState().volume` 同步为对应值（0–1）。
  2. 点击静音后 `state.muted === true`、滑块归零。
  3. 静音状态下拖动滑块至 >0 → 自动恢复出声（`state.muted === false`）。
  4. `setVolume(v)` 与滑块双向同步（外部调用 `setVolume` 时滑块位置跟随更新）。
  5. 音量范围钳制在 `[0, 1]`，越界值不产生异常。

### US-04 懒实例化：`PlayerConfig.autoplay=false` 时不自动起播
- **目标**：验证 **构造函数级** `autoplay:false` 时不发起加载，等显式 `play()`。
- **配置**：`{ container:'#player', url:'…m3u8' }`（不传 autoplay）。
- **交互**：打开页面 → 静置 3s → 读取状态。
- **预期**：
  1. 3s 内 `player.getState().playing === false`。
  2. 未发起 m3u8 网络请求（Network 面板无对应请求）。
  3. 调用 `player.play()` 后正常起播，返回 `Promise<void>`。

> 注意与 US-39 区分：本用例是**构造级**开关（createPlayer 后要不要自动 play）；
> US-39 是**起播级**开关（这一次 play() 里要不要自动播放）。两者语义正交，不可混用。

### US-05 暂停后恢复播放（`play()` 无参双语义）

- **目标**：确认「暂停 → 再起播」是**恢复播放**而非重新拉流，且不抛错——这是 UI 播放按钮的最高频路径。
- **配置**：**provider 模式**（`createPlayer` 不传 `url`，起播走 `play(() => ({ url, quality }))`）——该场景专门覆盖"`config.url` 为空"的陷阱。
- **交互**：
  1. 起播后点击播放/暂停按钮（暂停）。
  2. 再点一次（恢复）。
- **预期**：
  1. 暂停后按钮变 `▶`、`video.paused === true`。
  2. 恢复后按钮变 `⏸`、`video.paused === false`、`currentTime` 持续前进。
  3. **全程无 `unhandledrejection`、无控制台报错**（回归重点：旧实现会抛「未提供播放地址」）。
  4. 恢复过程**不重新发起 manifest 请求**（证明未重新 load，仅 `media.play()`）。
  5. 从未起播过的实例调用无参 `play()` 应明确报错（fatal），不静默失败。

---

## 二、起播输入（PlayConfig Provider）

### US-06 服务端下发地址起播（provider 模式）

- **目标**：播放地址由业务接口动态下发，而非写死。
- **配置**：
  ```js
  player.play(async () => {
    const res = await fetch('/api/live/play-config')
    return res.json()   // { url, backup, liveStatus, autoplay, muted, poster, quality }
  })
  ```
- **交互**：调用 `player.play(provider)`。
- **预期**：
  1. provider 被调用一次且仅一次（同次起播不重复请求）。
  2. `PlayConfig.url` 生效，播放器正常起播。
  3. provider 返回的 `autoplay`/`muted` 覆盖构造配置。
  4. provider 抛错 → `play()` reject，走 `error` 事件（`fatal:true`），不静默失败。

### US-07 备用流（backup）

- **目标**：主地址不可用时自动或手动切到备用流。
- **配置**：provider 返回 `{ url: '主流', backup: '备用流' }`。
- **交互**：模拟主地址 404 → 观察行为。
- **预期**：
  1. 主地址失败后 SDK 自动尝试 `backup`。
  2. 备用流成功则播放继续，接入方无感知。
  3. 两者都失败 → 最终 `error` 且 `fatal:true`。

### US-08 直播状态轮询（liveStatus）

- **目标**：区分「未开播 / 直播中 / 已结束」，并拿到结构化 payload。
- **配置**：provider 返回 `{ liveStatus: '/api/live/status' }`。
- **交互**：接口分别返回「未开播」「直播中」「已结束」三种状态（可附带业务自定义字段）。
- **预期**：
  1. 状态变化经事件对外通知（`live_status`），**仅在值变化时派发**（同值重复轮询不重复派发）。
  2. payload 为结构化对象：`{ status, previousStatus, raw, time }`。
  3. `raw` 为服务端原始响应**原样透传**——业务自定义字段（如主播信息、预计恢复时间）可直接取用，无需 SDK 改版。
  4. `previousStatus` 首次派发为空串，之后为上一次的值。
  5. 未开播时展示封面（`poster`）而非黑屏报错。
  6. 轮询有节流（默认 25s），非高频轰炸接口；失败静默退避。

---

## 三、清晰度（Quality / ABR）

### US-09 多码率档位自动对齐

- **目标**：业务档位与 master m3u8 的 streams 正确映射（主键 `height`，兜底 `bitrate`）。
- **配置**：
  ```js
  quality: [
    { id: 1, label: '蓝光 1080P', height: 1080 },
    { id: 2, label: '高清 720P',  height: 720  },
    { id: 3, label: '标清 540P',  height: 540  },
  ]
  ```
- **交互**：起播后读取 `player.getState().qualities`。
- **预期**：
  1. `qualities` 为**已映射到 streams 的有效档位**（映射不上的 id 被剔除）。
  2. 每档能在播放器上正确切换（见 US-10）。
  3. 服务端未写 `RESOLUTION` 时，`bitrate` 兜底生效。

### US-10 手动切档后 ABR 失效

- **目标**：`switchQuality(id)` 固定清晰度。
- **配置**：同 US-09。
- **交互**：调用 `player.switchQuality(2)` → 观察 hls.js 行为。
- **预期**：
  1. `getState().currentQuality === 2`。
  2. 切档后 hls.js 进入手动档（`manualLevel`），ABR 不再自动升降。
  3. 切档过程不中断播放（无缝切换）。

### US-11 档位映射失败时不阻塞播放

- **目标**：业务给了某 id，但 streams 里无对应档。
- **配置**：`quality` 含 `{ id: 99, height: 4096 }`（流里不存在）。
- **交互**：起播后读取 `qualities`。
- **预期**：
  1. `id:99` 不出现在 `qualities` 中。
  2. 有 warn 级上报（不影响播放）。
  3. 播放正常，不抛错、不阻塞。

---

## 四、能力对齐（getFeatureStatus）

### US-12 端到端能力对齐报告

- **目标**：报告「客户端能力 × 服务端提供」的对齐差距。
- **配置**：默认配置，多码率 + LL-HLS 测试流。
- **交互**：`manifest_parsed` 后调用 `player.getFeatureStatus()`。
- **预期**：
  1. 返回 4 项：`lowLatency` / `abr` / `qualitySwitch` / `drm`。
  2. 每项含 `client` / `server` / `matched` /（可选）`detail`。
  3. `drm` 的 `client` 恒为 `absent`（SDK 不内置 DRM）。
  4. `summary` 含 `matched` / `mismatched` 计数，且与数组一致。
  5. 同一报告经 `features_updated` 事件推送。

### US-13 LL-HLS 端到端可用性判定

- **目标**：只有「客户端支持 MSE + 服务端发 `EXT-X-PART` + fMP4」才算对齐。
- **配置**：分别用「有 PART 的流」与「无 PART 的流」。
- **交互**：对比两次 `getFeatureStatus()` 的 `lowLatency` 项。
- **预期**：
  1. 有 PART 且客户端支持 → `matched:true`。
  2. 无 PART 或客户端不支持 → `matched:false`，`detail` 指明缺失侧。

---

## 五、网络自适应（NetworkConfig）

### US-14 动态网络参数按质量档求值

- **目标**：`targetLatency` 等都是 `number | (q)=>number`，按网络质量动态取值。
- **配置**：
  ```js
  network: {
    targetLatency: (q) => ({ good: 3, fair: 5, poor: 8, offline: 8 })[q],
    retryCount:    (q) => ({ good: 2, fair: 4, poor: 6, offline: 6 })[q],
  }
  ```
- **交互**：模拟网络从 good 降到 poor（DevTools throttle）。
- **预期**：
  1. 参数随最近一次网络质量重新求值。
  2. 弱网下目标延迟抬升、重试次数增加（可经日志/上报核对）。
  3. `offline` 时进入等待恢复而非立即 fatal。

### US-15 静态值仍受支持

- **目标**：不写函数时按静态值处理。
- **配置**：`network: { maxLatency: 20, loadTimeout: 10000 }`。
- **交互**：正常播放 + 弱网切换。
- **预期**：参数恒为静态值，不随网络质量变化。

---

## 六、错误与重连

### US-16 可恢复错误自动重连（接入方无需写重连）

- **目标**：网络抖动导致的错误由 SDK 内部指数退避重连。
- **配置**：默认。
- **交互**：播放中模拟短暂断网 3s 后恢复。
- **预期**：
  1. 收到 `error` 事件但 `fatal:false`。
  2. SDK 自动重连，恢复后 `playing === true`。
  3. 接入方未写任何重连代码。
  4. 重连间隔呈指数退避，非固定高频重试。

### US-17 fatal 错误需接入方介入

- **目标**：SDK 尽力后仍不可用才置 `fatal:true`。
- **配置**：默认。
- **交互**：用不存在的地址（manifest 404）。
- **预期**：
  1. `error` 事件 `fatal:true`。
  2. 重试次数达到 `retryCount` 后停止重试。
  3. 接入方可据此展示错误 UI。

### US-17a 重试时记录当前播放地址与网络环境

- **目标**：每次错误/重连都能拿到「哪条流、在什么网络下、重试到第几次」的上下文，便于线上排查。
- **配置**：默认（无需额外配置）；也可接自定义 `ReporterPlugin` 转发。
- **交互**：播放中触发可恢复错误（如断网 3s 后恢复）。
- **预期**：
  1. `error` 事件的 `e.diagnostic` 非空，含 `url`（本次实际请求地址）、`primaryUrl`（业务下发主地址）、`isBackup`（是否已切备用流）。
  2. 含网络环境：`networkQuality`（`good/fair/poor/offline`）、`online`、`visibility`，以及支持 Network Information API 的浏览器上的 `effectiveType / downlink / rtt`。
  3. 含缓冲/进度上下文：`bufferBehind`、`bufferRemaining`、`currentTime`。
  4. 含重试元信息：`retryCount`（从 1 起）、`delay`（本次退避 ms）、`errorCode`、`time`。
  5. `retry` 事件载荷同样带 `diagnostic`；上报插件收到的 `ReportRecord.data.diagnostic` 与之一致。
  6. `player.getLastRetryDiagnostic()` 可读取最近一次快照（无重试时为 `null`）。

### US-17b 切换备用流时诊断反映真实请求地址

- **目标**：诊断中的地址是**实际请求**的那条，而非永远显示主地址。
- **配置**：`play({ url: 主地址, backup: 备用地址 })`。
- **交互**：首次重连（第 1 次重试会切到 `backup`）。
- **预期**：
  1. 第 1 次重试的 `diagnostic.url === backup`，且 `isBackup === true`。
  2. `diagnostic.primaryUrl` 仍为主地址，便于对比判断已切流。
  3. 超过 1 次后的重试回到主地址，`isBackup === false`。

### US-18 play / switchURL 的 Promise 语义

- **目标**：两者都是一次「起播」，resolve=播起来了，reject=SDK 尽力后失败。
- **配置**：默认。
- **交互**：`await player.play(可用地址)` 与 `await player.switchURL(不可用地址)`。
- **预期**：
  1. 成功起播 → `play()` resolve。
  2. `switchURL` 到坏地址 → reject。
  3. 可恢复错误**不**导致 reject（走内部重连）。

---

## 七、切流与生命周期

### US-19 运行中切流（switchURL）

- **目标**：保留会话状态换流地址。
- **配置**：默认。
- **交互**：播放中点「换流」按钮 → `player.switchURL(另一地址)`。
- **预期**：
  1. 切换到新地址，新流起播后 Promise resolve。
  2. 音量/静音等设置保留。
  3. 旧内核资源被释放（无内存泄漏、无残留请求）。

### US-20 销毁契约

- **目标**：`destroy()` 后内核建的 DOM 由内核清理。
- **配置**：默认。
- **交互**：调用 `player.destroy()`。
- **预期**：
  1. `container` 内的 `<video>` 与默认控件被移除。
  2. 状态订阅不再回调。
  3. 所有网络请求/定时器停止。
  4. 重复调用 `destroy()` 不抛错（幂等）。

---

## 八、状态与事件（三契约）

### US-21 订阅而非轮询

- **目标**：UI 靠订阅状态更新，不轮询。
- **配置**：默认。
- **交互**：`player.subscribe(cb)` 后触发一次静音切换。
- **预期**：
  1. `subscribe` **仅在状态变更时**回调（初始快照用 `getState()` 取）。
  2. 快照不含高频进度字段（`currentTime`/`duration`/`buffered`）。
  3. `unsubscribe` 后不再回调。

### US-22 事件值域一致性

- **目标**：事件枚举值与字符串两种写法等价。
- **配置**：默认。
- **交互**：分别用 `player.on(Events.FIRST_FRAME, cb)` 与 `player.on('first_frame', cb)`。
- **预期**：
  1. `Events.FIRST_FRAME === 'first_frame'`。
  2. 两种写法均能收到回调。
  3. 首帧事件触发一次 `first_frame`。

### US-23 扩展状态命名空间

- **目标**：插件/业务可往状态里加 `app.*` 字段而不被内核覆盖。
- **配置**：默认。
- **交互**：
  1. `player.setAppState({ 'app.foo': 1, 'app.roomId': 'r1' })`。
  2. 读取 `player.getState()['app.foo']`。
  3. 尝试写入内核字段：`player.setAppState({ playing: true })`。
- **预期**：
  1. `app.*` 字段被写入快照，`subscribe` 回调收到含该字段的全量快照（可用于驱动框架重渲染）。
  2. 内核不预设、不覆盖该命名空间。
  3. **非 `app.*` 键被忽略**：`playing` 等内核字段值不变，且控制台出现一条告警（运行时兜底，防 JS 调用方绕过类型约束）。
  4. 空 patch 不触发 `subscribe` 回调。

---

## 九、可观测与上报

### US-24 观测档位 full / basic

- **目标**：观测深度可静态配置。
- **配置**：分别用 `observability:'full'` 与 `'basic'`。
- **交互**：对比 `getStats()` 返回字段。
- **预期**：
  1. `full`：返回分片/缓冲/码率/ABR/速率等深度集。
  2. `basic`：仅 `<video>` 标准事件基线，`getStats()` 返回受限集。
  3. `capabilities.stats` 与配置一致。

### US-25 自定义上报插件（ReporterPlugin）

- **目标**：可观测数据可自定义输出（对接 Sentry / 自建埋点）。
- **配置**：
  ```js
  class MyReporter extends BasePlugin {
    report(record) { navigator.sendBeacon('/log', JSON.stringify(record)) }
  }
  createPlayer({ …, preset: [MyReporter] })
  ```
- **交互**：触发一次错误 + 一次指标。
- **预期**：
  1. `report(record)` 收到 `{ type, code, level, data, time }`。
  2. 多路上报插件同时生效（SDK 广播分发）。
  3. `ConsoleReporter` 是官方默认实现（平台能力、零第三方绑定）；**第三方适配（Sentry / 自建埋点）由接入方实现**，样板见 `examples/reporter-sentry.ts`。

### US-26 自定义 Sentry 上报（参考实现）

- **目标**：不硬依赖 `@sentry/browser`，注入式接入；且**传出去的数据必须真的到 Sentry**。
  SDK **不内置** Sentry 适配器（第三方系统能力不属核心职责），本用例验收的是**参考实现样板**
  `examples/reporter-sentry.ts` —— 它是接入方会直接复制的代码。
- **配置**：`registerPlugin(SentryReporter, { sentry })`（样板自带该类）。
- **交互**：触发 error（含 `diagnostic` 快照）与非 error 记录；分别以 `level` 为 `fatal` / `warn` / `info` 各触发一次。
- **预期**：
  1. error 走 `captureException`。
  2. 非 error 走 `addBreadcrumb`。
  3. 未注入 sentry 时不抛错（降级为无操作）；`sentry` 未实现可选的 `addBreadcrumb` 也不影响 error 上报。
  4. **`record.data` 必须包在 `extra` 下**：Sentry 合并 CaptureContext 用的是**显式字段白名单**（`tags`/`extra`/`contexts`/`user`/`level`/`fingerprint`/…），**没有透传机制**，顶层未知键会被**静默丢弃**。平铺 `record.data` 会让 `message` / `domain` / `retryCount` / `diagnostic` 全部丢失。
  5. **到达 Sentry 的 `extra.diagnostic` 含 `url` / `networkQuality` 等字段**（回归重点：早先平铺导致快照根本没进 Sentry，而客户端不报错、测试也不失败）。
  6. **`level` 需映射**：SDK 的 `'warn'` → Sentry 的 `'warning'`（Sentry 合法值为 `'fatal'|'error'|'warning'|'log'|'info'|'debug'`，**没有 `'warn'`**），否则等级落在无效值上、订阅规则失效。
  7. `extra.code` 也带上错误码，便于在 Sentry 里按码检索。
  8. 除 `level` / `extra` 外不应有其它顶层键（有则说明又平铺了）。
  9. **样板本身不得腐烂**：`examples/` 由 `examples/tsconfig.json` 编译（并入 `npm run verify`），
     行为由 `test/reporter-sentry-example.test.ts` 断言 —— 示例写错会失败，而不是悄悄过期。

---

## 十、宿主环境适配（App WebView）

### US-27 JSBridge 可见性适配

- **目标**：App WebView 中显示/隐藏无法用 Web API 判断，改由原生回调。
- **配置**：
  ```js
  env: new JSBridgeEnvAdapter({ /* 桥接对象 */ })
  ```
- **交互**：App 触发前台/后台切换。
- **预期**：
  1. `getVisibility()` 返回 `foreground`/`background`。
  2. 后台时暂停拉流，前台恢复。
  3. 桥接不可用时降级为 Web API（`visibilitychange`）。

### US-28 自定义网络质量来源

- **目标**：`EnvAdapter` 可提供 App 侧的网络质量。
- **配置**：适配器实现 `getNetworkQuality()`。
- **交互**：App 上报网络从 good → poor。
- **预期**：
  1. `NetworkConfig` 的动态函数按新质量重新求值。
  2. 适配器未实现该方法时，SDK 使用内部推断。

---

## 十一、UI 定制

### US-29 默认 UI 一键挂载

- **目标**：`mountDefaultUI(player)` 装配一组 UIPlugin。
- **配置**：默认。
- **交互**：调用 `mountDefaultUI(player)`。
- **预期**：
  1. 控件挂进 `player.root`，叠在 video 上。
  2. 与「自绘 UI 同源」——本质是 UIPlugin 组合。
  3. `destroy()` 后控件一并清理。

### US-30 自绘 UI（React / Vue / 纯 JS）

- **目标**：接入方用框架自绘控件，仍消费三契约。
- **配置（React）**：
  ```jsx
  import { createPlayer } from '@fancaf/live-sdk'
  import { usePlayer } from '@fancaf/live-sdk/react'
  const { playing, muted } = usePlayer(player)
  ```
- **配置（Vue）**：
  ```js
  import { usePlayer } from '@fancaf/live-sdk/vue'
  const state = usePlayer(playerRef)   // Ref<PlayerState|null>
  ```
- **交互**：点击自绘的播放/静音按钮。
- **预期**：
  1. React：`usePlayer(player)` 返回 `PlayerState`，变更触发重渲染，卸载自动取消订阅。
  2. Vue：`usePlayer(Ref<Player|null>)` 在 player 就绪后开始同步；就绪前返回 `null`。
  3. 两种适配器都不修改内核，仅薄封装三契约。

### US-31 跨插件联动靠共享状态

- **目标**：插件间不互相引用，靠同一状态联动。
- **配置**：两个插件同订阅状态（如清晰度面板 + 档位角标）。
- **交互**：切清晰度。
- **预期**：
  1. 一个插件改状态，另一个自动同步（无相互引用）。
  2. 移除任一插件，另一个仍正常。

### US-32 无构建接入（CDN）

- **目标**：不依赖工程化，CDN 直接跑。
- **配置（纯 JS）**：
  ```html
  <script src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js"></script>
  <script src="https://unpkg.com/@fancaf/live-sdk/dist/live-sdk.umd.js"></script>
  <script>const { createPlayer } = LiveSdk</script>
  ```
- **配置（Vue 完整版）**：`vue.global.prod.js` + `LiveSdkVue.usePlayer`，模板写 DOM 内。
- **配置（React）**：React UMD + `@babel/standalone` 编译 JSX + `LiveSdkReact.usePlayer`。
- **交互**：直接打开 HTML。
- **预期**：
  1. 三种方式均无需构建工具即可起播。
  2. 全局变量分别为 `LiveSdk` / `LiveSdkUI` / `LiveSdkReact` / `LiveSdkVue`。
  3. 无 `require`/模块解析报错。

### US-33 暂停/恢复后按钮状态即时一致

- **目标**：点暂停后按钮立刻变「播放」，恢复后立刻变「暂停」，不与画面错位。
- **配置**：默认 UI（`mountDefaultUI`）或任何订阅 `PlayerState` 的自绘 UI。
- **交互**：播放中点暂停按钮；再点一次恢复。
- **预期**：
  1. 点击后**同步**（同一事件循环内）`getState().playing` 即为新值，无需等下一帧。
  2. 按钮文案与 `getState().playing`、`media.paused` 三者一致。
  3. 不出现「画面已暂停、按钮仍显示播放中」。

### US-34 切换清晰度不影响播放/暂停状态

- **目标**：切档只改变画质，不改变按钮的播放/暂停语义。
- **配置**：业务下发 `PlayConfig.quality`，播放中选择某档。
- **交互**：播放中切换清晰度；暂停后切换清晰度。
- **预期**：
  1. 播放中切档 → `playing` 保持 `true`，按钮维持「暂停」图标。
  2. 暂停中切档 → `playing` 保持 `false`，按钮维持「播放」图标，不被切档引发的缓冲事件「复活」为播放中。
  3. 切档成功后有 `quality_change` 事件，`currentQuality` 为新档 id。

### US-35 缓冲中（stalled）暂停后不被事件复活

- **目标**：用户在缓冲卡顿时点暂停，后续网络事件不得把状态改回播放中。
- **配置**：默认。
- **交互**：制造缓冲停滞（`waiting`）→ 在停滞期间点暂停。
- **预期**：
  1. 停滞期间 `playing` 仍为 `true`（UI 语义：还在播，只是缓冲）。
  2. 点暂停后 `playing` 立即为 `false`。
  3. 随后继续到达的 `waiting` / `stalled` 事件不把 `playing` 改回 `true`。

### US-36 断流重连期间按钮保持「播放中」

- **目标**：可恢复错误触发自动重连时，按钮不闪回「播放」。
- **配置**：默认（自动重连）；建议用 `network.retryDelay` 放大退避间隔便于观察。
- **交互**：播放中制造连续网络错误，使 SDK 进入 `error → retry → loading` 并最终重试成功。
- **预期**：
  1. `stalled` 期间 `playing` 保持 `true`（UI 仍是播放中）。
  2. `error` / `retry` / `loading` 全过程中 `playing` **仍为 `true`**——重连是 SDK 内部恢复过程，媒体真实暂停态未变、用户播放意图未变，按钮不得在退避等待（可达数秒）中闪现「播放」图标。
  3. 重试成功回到 `ready` 后 `playing` 仍为 `true`——**即使浏览器不再派发 `playing` 事件**（同源重新 load 时常见）。
  4. 可在 `retry` 事件中观察到 `retryCount` 递增与指数退避 `delay`。

### US-37 重连期间用户显式暂停必须被尊重

- **目标**：自动重连不得覆盖用户在重连过程中按下的暂停。
- **配置**：默认。
- **交互**：播放中触发重连 → 在退避等待期间点击暂停 → 等待重试成功。
- **预期**：
  1. 点击暂停后 `playing` 立即为 `false`。
  2. 重试成功后 `playing` **仍为 `false`**，不自动复活为播放状态。
  3. 用户需再次点击播放才会恢复（意图仍以用户操作为准）。

### US-38 重试失败错误可经上报记录追溯

- **目标**：重试耗尽等问题可从上报数据回溯「哪条流、什么网络、第几次」。
- **配置**：接自定义 `ReporterPlugin`（或默认 `ConsoleReporter` 看控制台）。
- **交互**：制造持续错误直至 `retry_exhausted`。
- **预期**：
  1. 上报记录含 `error` 类型（`level: fatal`）与 `code: retry_exhausted`。
  2. `data.diagnostic` 含 `url` / `primaryUrl` / `networkQuality` / `online` / `visibility` 等字段。
  3. `retry` 事件也有对应的 `event` 类型记录，`data` 中带同一诊断快照。

---

## 十二、业务实测反馈修复（0.2.0）

### US-39 起播级 autoplay：只加载不自动播

- **目标**：`PlayConfig.autoplay:false` = 「只加载、不自动起播」，把起播时机交给用户手势（配合封面图）。
- **配置**：`player.play({ url:'…m3u8', poster:'…jpg', autoplay:false })`，`createPlayer({ posterMode:'overlay' })`。
- **交互**：调用 `play({ autoplay:false })` → 等 manifest 就绪 → 观察状态 → 再调用无参 `play()`。
- **预期**：
  1. manifest 已加载（Network 面板可见 m3u8/分片请求），但 `video.paused === true`、`getState().playing === false`。
  2. 播放按钮呈「播放」态（意图为负，不得显示为播放中）。
  3. 封面图持续显示，不被隐藏。
  4. 之后无参 `play()` 正常开始播放，`playing` 转 `true`（走「恢复播放」分支，不重新拉流）。
  5. 与 US-04 的区别：US-04 测**构造级** `PlayerConfig.autoplay`，本用例测**起播级** `PlayConfig.autoplay`；**缺省（不传）时视为 `true`**，保持既有行为。

### US-40 封面图叠加层（posterMode: 'overlay'）

- **目标**：MSE 路径下封面图稳定呈现——原生 `<video>.poster` 在 hls.js 接管 `src` 为 `blob:` 后不可靠。
- **配置**：`createPlayer({ posterMode:'overlay' })`，`play({ poster:'…jpg' })`。
- **交互**：起播 → 观察封面 → 首帧渲染。
- **预期**：
  1. 容器内出现一个绝对定位的 `<img>` 图层（`class="live-sdk-poster"`），`src` 为封面地址，且 `<video>.poster` **不被写入**（避免重复呈现）。
  2. 首帧呈现（`playing` / `first_frame`）后图层隐藏（`display:none`）。
  3. 图层 `z-index` 低于默认控件层，**不遮挡**播放/音量/全屏按钮的点击。
  4. `posterMode` 缺省为 `'native'`：不创建图层，改写 `<video>.poster`（保持既有行为）。
  5. `destroy()` 后图层被移除。

### US-41 错误码映射大小写不敏感（接口/CDN 异常可观测）

- **目标**：hls.js 的 `details` 是 camelCase（`manifestLoadError`），必须能被正确归类——否则错误码全部落到 `unknown`，「接口与 CDN 异常可观测」失效。
- **配置**：默认（构造错误即可观测）。
- **交互**：制造以下异常，观察 `error` 事件的 `code` 与上报记录。
  1. 主 playlist 404。
  2. 分片加载失败。
  3. manifest 解析失败（fatal）。
- **预期**：
  1. 主 playlist 404 → `code === 'manifest_404'`；普通 manifest 失败 → `manifest_load_error`；分片失败 → `frag_load_error`。
  2. **不得出现**「明明有明确异常却报 `unknown`」的情况（回归重点）。
  3. camelCase 与全大写两种书写都能正确归类（自研内核风格兼容）。
  4. HTTP 404 来自响应状态码（hls.js 放在 `data.response.code`，不在 `details` 里）。
  5. 致命错误（manifest/codec/key/mediaError）的 `fatal === true`，可恢复错误 `fatal === false` 并自动重连。

### US-42 播放进度字段（currentTime / duration）

- **目标**：状态快照可读播放位置与时长，用于状态展示/埋点，且不引起订阅方高频重渲染。
- **配置**：默认。
- **交互**：起播 → 播放若干秒 → 读取 `getState()`；再对 HLS 点播流重复。
- **预期**：
  1. `getState().currentTime` 为当前播放位置（秒），随播放推进。
  2. **节流**：同一整秒内多次 `timeupdate` 只写一次快照（订阅回调次数 ≈ 每秒 1 次，而非 ~4 次）。
  3. 直播流 `getState().duration === Infinity`（如实透传规范行为，不伪造成 0）。
  4. HLS 点播流（`#EXT-X-ENDLIST`）`duration` 为有限值。
  5. 元数据未就绪时 `duration === 0`，不出现 `NaN`。
  6. 新一轮起播（切流/重播）后进度归零。

### US-43 插件注册兼容实例（registerPlugin）

- **目标**：`registerPlugin` 同时接受构造器与实例，贴合常见插件 API 习惯。
- **配置**：自定义 `BasePlugin` 子类。
- **交互**：
  1. `player.registerPlugin(MyPlugin)`。
  2. `player.registerPlugin(new MyPlugin())`（另一个播放器实例上）。
- **预期**：
  1. 传构造器：SDK 实例化，返回该实例，`create` / `init` 被调用一次。
  2. 传实例：SDK **复用**传入的同一对象（`registerPlugin(x) === x`），同样调用 `create` / `init`，业务可继续持有并使用该引用。
  3. 同名插件重复注册被忽略（返回已有实例，不重复初始化）。
  4. `preset` 数组仍只接受构造器。

---

## 十三、全屏目标与容器级全屏（0.5.0）

### US-44 指定全屏目标（`requestFullscreen(target?)`）

- **目标**：自绘控件挂在容器里（`<video>` 不能有子元素），全屏后不能消失。
- **配置**：默认；自绘控件栏挂在业务容器内（或直接用 `mountDefaultUI(player)`）。
- **交互**：
  1. `player.requestFullscreen()`（不传参）。
  2. 退出后 `player.requestFullscreen(player.root)`。
  3. 退出后传业务自己的外层容器。
- **预期**：
  1. 不传参 → 全屏 `<video>`（历史行为，兼容不变）。
  2. 传容器 → **全屏该容器**：全屏内自绘控件/控件栏仍**可见、可点**（播放、暂停、切档、退出全屏均可用）。
  3. 传容器时不会误触 `<video>` 全屏。
  4. iOS Safari 不支持普通元素全屏时，**自动回退原生视频全屏**（控件不可见，但至少能全屏，不是「点了没反应」）。
  5. 无任何全屏能力的环境静默降级，不抛错、不产生 `unhandledrejection`。

### US-45 容器级全屏时 `fullscreen` 快照正确同步

- **目标**：无论全屏的是 `<video>` 还是容器，`PlayerState.fullscreen` 都要正确反映。
- **配置**：默认。
- **交互**：
  1. 用 `requestFullscreen(player.root)` 进入容器全屏。
  2. 读取 `player.getState().fullscreen`。
  3. 退出全屏后再读。
  4. （回归）接入方**不经过 SDK**、自行对容器调 `element.requestFullscreen()`。
- **预期**：
  1. 容器全屏时 `fullscreen === true`（**回归重点**：早先只判 `fullscreenElement === video`，容器全屏恒为 `false`，导致图标不切换、按钮退不出全屏）。
  2. 退出后 `fullscreen === false`。
  3. `<video>` 自身全屏时同样为 `true`。
  4. iOS 原生视频全屏（`webkitDisplayingFullscreen`）同样为 `true`——它不派发 `fullscreenchange`、也不体现在 `document.fullscreenElement`。
  5. 接入方自行对容器全屏（绕过 SDK）也能被感知，**因此业务不必再自己维护一份全屏状态**。
  6. 默认 UI 的全屏按钮：点一次进入、再点一次退出（不会出现"被困在全屏"）。

---

## 十四、错误域 / 命令观测 / 接入自检（0.5.0）

### US-46 错误域：一次分流，不必自建错误码映射表

- **目标**：接入方能按「该去哪儿排查」分流错误，而不必自己维护「错误码 → 方向」映射表（该表会随 SDK 新增错误码而失同步）。
- **配置**：默认。
- **交互**：
  1. 订阅 `error`，读 `err.domain`。
  2. 制造各类异常：主 playlist 404、分片失败、断网超时、解码失败、无可用内核、`play()` 被自动播放策略拦截。
  3. 对任意错误码字符串调 `errorDomainOf(code)`。
- **预期**：
  1. `err.domain` 取值恒为 `'network'` / `'decode'` / `'config'` / `'unknown'` 之一，且**恒存在**。
  2. network 域：`manifest_404` / `manifest_load_error` / `frag_load_error` / `network_error` / `load_timeout` / `retry_exhausted`。
  3. decode 域：`media_decode_error` / `media_src_not_supported` / `drm_no_license`。
  4. config 域：`config_resolve_failed` / `no_supported_kernel` / `play_failed`。
  5. **未知码如实为 `unknown`，不被猜成 decode**（回归重点：业务侧旧实现是「不认识就保守归解码」，会把真实未知故障伪装成解码问题、排查方向跑偏）。
  6. 出参**与 `ERROR_CODE` 全量对齐**：SDK 新增错误码若未登记域，SDK 自身测试即失败（接入方不会收到 `unknown`）。

### US-47 统一命令观测（COMMAND 事件）

- **目标**：一次订阅即可统计「用户做了什么操作、有没有生效」，替代逐命令订阅 + 手动上报。
- **配置**：默认。
- **交互**：
  1. 订阅 `command` 事件。
  2. 依次调用全部 12 个命令（`play` / `pause` / `mute` / `setVolume` / `switchQuality` / `switchURL` / `requestFullscreen` / `exitFullscreen` / `seek` / `setPlaybackRate` / `setPoster` / `setLiveLatency`）。
  3. 用 `useHooks('play', ...)` 在 before 阶段把 `ctx.cancelled` 置 `true` 后调用 `play()`。
  4. 在直播无限流（`duration === Infinity`）下调 `seek()`。
- **预期**：
  1. 12 个命令**全部**派发 `COMMAND`；`COMMAND_NAMES` 可在运行时枚举出这 12 个名字。
  2. 每个命令的 `before` / `after` **严格成对**（顺序为先 before 后 after）。
  3. `applied` **只出现在 `after` 阶段**且恒为 `boolean`；`before` 阶段为 `undefined`。
  4. `seek` 在直播无限流下 `applied === false`；在有限时长（点播/重播）下 `applied === true` 且定位生效。
  5. `switchQuality` 传入档位表里不存在的 id → `applied === false`。
  6. **被 before 钩子拦截的命令仍派发 `after`，且 `applied === false`**（不是静默不派发）——接入方能区分「用户没点」与「点了但没生效」。
  7. `play({ autoplay: false })` 的 `applied === true`（它完成了被要求的事：加载但不自动播），是否真的在播看 `PlayerState.playing`。
  8. 载荷含 `time`（`Date.now()`）。
  9. ⚠️ `setVolume` 在滑块拖动时可能高频派发，接入方统计交互时应自行节流。

### US-48 容器零尺寸告警（接入排查加速）

- **目标**：覆盖「接入后画面不显示」最常见的原因——容器没有高度。
- **配置**：默认。
- **交互**：
  1. 容器样式为 `width:100%` 但父级无确定高度（`height` 实际为 0）→ 调 `play()`。
  2. 容器尺寸正常（如 `640×360`）→ 调 `play()`。
  3. 连续两次 `play()`。
  4. 非浏览器环境 / DOM 替身（无 `getBoundingClientRect` 与 `offsetWidth`）→ 调 `play()`。
- **预期**：
  1. 零尺寸时控制台出现一条明确告警：`容器尺寸为 0（0×0），播放器不会有可见画面。请给容器或其父级确定的高度…`。
  2. **只告警一次**，重复 `play()` 不重复刷屏。
  3. 尺寸正常时**不告警**。
  4. **测不到尺寸时不告警**（关键：不能把「测不到」当成 0，否则测试与 SSR 场景满屏误报）。
  5. 仅有宽度、高度为 0（父级无高度的经典场景）同样告警。
  6. 告警**不阻断**播放流程（`play()` 照常返回、不抛错）。

---

## 十五、破坏性变更（0.6.0）

> 本节的两条都是**移除**。判据相同：被移除的东西要么已被更好的机制取代，要么不属于 SDK 的核心职责。
> 升级前请对照自查 —— 两者都不会在编译期以外的地方报错（JS 接入方尤其要看）。

### US-49 能力探测归位：`sniffer` 命名空间移除（UA 嗅探更早已移除）

- **目标**：平台差异一律用能力判定；并且**探测代码住在平台层**，不作为「平台无关的公开工具」导出
  —— 原 `utils/sniffer.ts` 整个模块都是 Web 实现（`window` 能力位 + `video.canPlayType`），放在 `utils/` 下是分类错误。
- **配置**：默认（无配置项）。
- **交互**：
  1. `import * as sdk from '@fancaf/live-sdk'`，检查 `sniffer` 是否为导出。
  2. 需要「这个媒体设备能不能播某格式」时，用 `player.canPlay(mime)`。
  3. 平台判定迁移：过去 `if (isIOS()) { video.webkitEnterFullscreen() }` → 现在 `if (typeof video.webkitEnterFullscreen === 'function')`。
- **预期**：
  1. **`sniffer` 不再从主入口导出**（`'sniffer' in sdk === false`）；`src/utils/sniffer.ts`（拆解）与
     `src/utils/fullscreen.ts`（搬运到 `platform/web/`）**均已不存在**。
  2. `player.canPlay('application/vnd.apple.mpegurl')` 可用：Web 实现把 `canPlayType()` 的三态
     收敛为布尔 —— **非空即可播**，`'maybe'` 与 `'probably'` 都算 `true`。
  3. **媒体设备能力（能否播某 MIME）在 `MediaSurface` 契约上；宿主能力（MSE）在平台实现内且不对外导出。**
     接入方若确有需要，应在自己的平台实现里探测，而不是依赖 SDK 导出的探测函数。
  4. `isIOS` / `isSafari` / `isAndroid` / `supportsH264` / `canAutoplay` **均不存在**
     （这 5 个在 0.5.0 及更早版本存在；它们当时**零引用零测试**、占该文件 51%，SDK 内部从未调用）。
  5. `canAutoplay` 的替代不是另一个探测函数：起播可行性由**运行时**承担
     （`playIntent` + 捕获 `NotAllowedError` 后回滚快照）—— 预探测会误判，因为探测时的手势状态 ≠ 真正起播时的。
  6. **内核选路不受影响**：`observability: 'basic'` 下仍是「原生可播 HLS → 原生可播 MP4 → MSE」，
     其中前两项改问 `media.canPlay()`、第三项问平台侧 MSE 探测；`'full'` 档仍优先 `HlsKernel`，
     无 MSE 时落 `NativeKernel`。
  7. iOS 17.1+ / macOS 14.1+ 仍走 ManagedMediaSource（`HlsKernel` 不再自行探测，改为交由 hls.js 降级）—— 见 US-52。
  8. 由三道门守住：`verify/exports.mjs`（公开面形状精确集合）、`verify/surface.mjs`（公开面活性）、
     `verify/layers.mjs`（`core` 不得依赖平台专有 utils）—— 「静默改名/删除」或「公开面漂移」构建即失败。

### US-50 上报适配器不再内置（第三方绑定移出核心）

- **目标**：核心只保留上报**通道契约**（`ReporterPlugin`），绑定具体第三方平台的适配器由接入方实现 —— 与「SDK 只做把直播播出来这一件事」的边界一致。
- **配置**：不注册任何上报插件（默认只随 `preset.live` 装配 `ConsoleReporter`）。
- **交互**：
  1. `import * as sdk from '@fancaf/live-sdk'`，检查 `SentryReporter` 是否为导出。
  2. 按 `examples/reporter-sentry.ts` 的样板实现自定义上报插件并 `registerPlugin`。
- **预期**：
  1. **`SentryReporter` 与 `SentryLike` 不再由 SDK 导出**（0.5.0 曾随主入口导出）。
  2. 参考实现位于 `examples/reporter-sentry.ts`（仓库内，**不随 npm 包分发**），接入方可直接复制。
  3. 该样板**受双重保护**，不会腐烂：`examples/tsconfig.json` 使 `npm run verify` 会编译它；`test/reporter-sentry-example.test.ts` 直接 import 它并断言行为（而非仅类型）。
  4. 样板内不可省的三个点（缺失即静默丢数据，详见 US-26）：`record.data` 必须包在 `extra` 下、`level` 需 `'warn' → 'warning'` 映射、`extra.code` 带上错误码。
  5. 自定义上报插件收到的载荷形状与事件通道**信息对等**（`type` / `code` / `level` / `data.domain` / `data.diagnostic` / `time`），见 US-38。

---

## 十六、平台契约与自定义平台（P0/P1 解耦改造）

### US-51 自实现平台接入（非 DOM 宿主 / 自研媒体面）

- **目标**：把「媒体面」「宿主承载」「宿主环境」三件事都换成自己的实现，**不改 SDK 源码** ——
  用于非 DOM 宿主（小程序 / 原生播放器容器）或自研播放器。
- **配置**：实现三组契约后自行装配；`createPlayer` 内部即「Web 平台包 + core」的默认装配形态。
  ```ts
  import { Player } from '@fancaf/live-sdk'
  import type { MediaSurface, HostMount, EnvAdapter, PlatformAdapters } from '@fancaf/live-sdk'

  const media: MediaSurface<MyHandle> = { /* play/pause/seek/muted/error/buffered/canPlay/on/destroy … */ }
  const host: HostMount<MyRoot>    = { /* mount/measure/showPosterOverlay/destroy … */ }
  const env: EnvAdapter            = { /* getVisibility/onVisibilityChange/isOnline … */ }
  const platform: PlatformAdapters<MyHandle, MyRoot> = {
    media, host, env,
    selectKernel: (url, observability) => MyKernel,   // 默认内核的选择属于平台
    presets: {},                                      // 默认插件由平台给出
  }
  const player = new Player({ container: myContainer, url }, platform)
  ```
- **交互**：按上面构造；调用 `play()` / 命令 / 订阅事件 / `destroy()`。
- **预期**：
  1. **无需 `document` / `window`**：整条链路（起播、命令、事件、进度、销毁）都能跑通 —— 由 `test/platform-seam.test.ts` 以「假媒体面 + 假承载面」证明。
  2. 命令落到**你实现的**媒体面（`play` / `pause` / `seek` / `muted` / `volume` / 全屏），状态快照随之更新。
  3. 媒体事件由**你实现的** `MediaSurface.on(event, cb)` 上抛，core 只认 `MediaEventName` 那一组名字。
  4. 零尺寸告警读 `HostMount.measure()`：**返回 `null`（测不到）不告警**，返回 0 尺寸才告警；提示文案由 `zeroSizeHint` 提供（平台相关）。
  5. 封面图层走 `HostMount.showPosterOverlay/hidePosterOverlay`，SDK 不会自己去建 DOM 节点。
  6. 容器解析（`string` → 元素）由**你的** `HostMount.mount` 负责；解析失败抛错时 SDK 会回收媒体面，不留副作用。
  7. 依赖方向由 `verify/layers.mjs` 强制：**core 不会反向依赖任何实现层** —— 这也是「换平台不必改 core」的机器保证。
  8. **已知边界**：`player.media` / `player.root` 的类型仍声明为 Web 类型（`HTMLVideoElement` / `HTMLElement`），
     非 Web 宿主需自行 `as` 收窄；完全类型中立（泛型放宽）尚未做，见 spec §3.9。
  9. **`canPlay(mime)` 必须由你回答**：内核选路会问它「你能不能直接播 HLS / MP4」—— 这正是它进契约的理由
     （换宿主不该靠 Web 的 `canPlayType` 语义外推）。小程序媒体面对 m3u8 直接返回 `true` 即可；
     `test/platform-seam.test.ts` 的假媒体面就是这么写的，可作为样板。

### US-52 ManagedMediaSource 行为保持（内核不再自行探测）

- **目标**：`HlsKernel` 去掉平台能力探测后，iOS 17.1+ / macOS 14.1+ 仍走 MMS（可内联播放、更省电），
  且**其余平台行为完全不变**。
- **配置**：`{}`（默认）。`hlsConfig.preferManagedMediaSource` 仍可覆盖。
- **交互**：iOS 17.1+ Safari 起播一条 HLS 流；Chrome 起播同一条流。
- **预期**：
  1. iOS 17.1+ 走 ManagedMediaSource；Chrome 走标准 MSE —— 与改动前一致。
  2. **依据**：hls.js 对 `preferManagedMediaSource` **自带可用性降级** ——
     `const mms = (prefer || !self.MediaSource) && self.ManagedMediaSource; return mms || self.MediaSource || self.WebKitMediaSource`。
     「prefer」与「MMS 存在」是 **AND**，故恒传 `true` 与「探测到才传 true」在所有组合下等价。
     好处是内核**不需要任何平台探测**，也就不会反向依赖平台实现层（见 US-49 第 8 条）。
  3. hls.js 自身的 config 默认值是 `false`（见其 `hlsDefaultConfig`），因此**这一项不能省** ——
     省掉会让 iOS 17.1+ 退回标准 MSE（这是本轮改动前特意核对过的点）。
  4. `hlsConfig.preferManagedMediaSource: false` 可显式关闭（该展开在 SDK 默认值之后）。
  5. **验收方式**：① 源码层核对 `HlsKernel#ensureHls` 传入的 `config`；② iOS 17.1+ 真机/模拟器手测内联播放；
     ③ 其余平台回归由现有 E2E 覆盖。⚠️ **第 1 条无法在 CI 自动化**（需要 iOS 真机与特定系统版本）。

---

## 附录：验收环境建议
| 项 | 建议 |
|---|---|
| 浏览器 | Chrome 最新版（MSE）、iOS Safari 16 与 17.1+（对照 US-02 / US-13） |
| 测试流 | mux 多码率、Apple fMP4 多码率、Akamai 直播（见 examples） |
| 弱网模拟 | DevTools Network Throttling（Slow 3G / Offline） |
| 断言手段 | 控制台读 `getState()` / `getFeatureStatus()`，或自动化脚本 |
| 上报核对 | `ConsoleReporter` 输出 + 自定义 Reporter 的 records |
