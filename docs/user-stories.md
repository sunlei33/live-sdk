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

### US-04 懒实例化：autoplay=false 时不自动起播
- **目标**：验证 `autoplay:false` 时不发起加载，等显式 `play()`。
- **配置**：`{ container:'#player', url:'…m3u8' }`（不传 autoplay）。
- **交互**：打开页面 → 静置 3s → 读取状态。
- **预期**：
  1. 3s 内 `player.getState().playing === false`。
  2. 未发起 m3u8 网络请求（Network 面板无对应请求）。
  3. 调用 `player.play()` 后正常起播，返回 `Promise<void>`。

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

- **目标**：区分「未开播 / 直播中 / 已结束」。
- **配置**：provider 返回 `{ liveStatus: '/api/live/status' }`。
- **交互**：接口分别返回「未开播」「直播中」「已结束」三种状态。
- **预期**：
  1. 状态变化经事件对外通知（`live_status`）。
  2. 未开播时展示封面（`poster`）而非黑屏报错。
  3. 轮询有节流，非高频轰炸接口。

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
- **配置**：自定义插件写入 `state['app.foo']`。
- **交互**：读取 `player.getState()['app.foo']`。
- **预期**：
  1. `app.*` 字段被保留。
  2. 内核不预设、不覆盖该命名空间。

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
  3. `ConsoleReporter` / `SentryReporter` 可作为官方参考实现。

### US-26 SentryReporter 接入

- **目标**：不硬依赖 `@sentry/browser`，注入式接入。
- **配置**：`registerPlugin(SentryReporter, { sentry })`。
- **交互**：触发 error 与非 error 记录。
- **预期**：
  1. error 走 `captureException`。
  2. 非 error 走 `addBreadcrumb`。
  3. 未注入 sentry 时不抛错（降级为无操作）。

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

## 附录：验收环境建议

| 项 | 建议 |
|---|---|
| 浏览器 | Chrome 最新版（MSE）、iOS Safari 16 与 17.1+（对照 US-02 / US-13） |
| 测试流 | mux 多码率、Apple fMP4 多码率、Akamai 直播（见 examples） |
| 弱网模拟 | DevTools Network Throttling（Slow 3G / Offline） |
| 断言手段 | 控制台读 `getState()` / `getFeatureStatus()`，或自动化脚本 |
| 上报核对 | `ConsoleReporter` 输出 + 自定义 Reporter 的 records |
