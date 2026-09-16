# live-sdk

> Headless H5 直播播放器 SDK —— 状态 / 命令 / 事件三契约，UI 完全外置。
>
> **Headless H5 live-streaming player SDK** — state / command / event contracts, with UI fully externalized.

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![npm](https://img.shields.io/badge/npm-%40fancaf%2Flive--sdk-cb3837.svg)](https://www.npmjs.com/package/@fancaf/live-sdk)

**语言 / Language**：[简体中文](#简体中文) · [English](#english)

---

# 简体中文

live-sdk 是一个面向 **H5 直播场景** 的播放器 SDK。内核无 UI、无框架绑定，只暴露三契约；UI、上报、宿主环境适配全部经由插件/适配器扩展。封装复杂度、保留可定制性——开箱即用，也能逐层下沉到完全自绘。

基于 **HLS（fMP4/CMAF 容器）+ hls.js** 落地：LL-HLS 低延迟、ABR 与手动清晰度、断流重连、网络质量自适应，并内建 **端到端能力对齐**（客户端能力 × 服务端实际提供）。

## 特性

- **Headless 内核**：状态 / 命令 / 事件三契约，UI 是外部消费者，可任意接管。
- **可插拔内核**：`HlsKernel`（hls.js + MSE / iOS MMS）与 `NativeKernel`（Safari 原生 HLS 回退）自动选路。
- **LL-HLS 低延迟**：fMP4 分片（`EXT-X-PART`）+ 运行时目标延迟调节。
- **清晰度 / ABR**：自动 ABR 与手动切档；业务档位与 master m3u8 以 `height` 主键对齐，索引复杂度封装在 SDK 内。
- **端到端能力对齐**：`getFeatureStatus()` 回报 `lowLatency` / `abr` / `qualitySwitch` / `drm` / `airplay` 的客户端与服务端匹配差距。
- **网络自适应**：目标延迟、重试次数、退避基数、超时均为「静态值或按网络质量动态求值」。
- **可观测分级**：`full`（深度采集）/ `basic`（仅 `<video>` 标准事件），静态配置。
- **插件化扩展**：`BasePlugin` 生命周期、`UIPlugin` 界面层、`ReporterPlugin` 上报、`EnvAdapter` 宿主适配。
- **框架适配器**：React / Vue `usePlayer`，零侵入消费三契约。
- **无构建可用**：提供 UMD 产物，CDN 直接 `<script>` 引入即可。

## 安装

```bash
npm install @fancaf/live-sdk
# 或
pnpm add @fancaf/live-sdk
```

`hls.js` 为运行时依赖，随包自动安装。React / Vue 适配器为可选 peer 依赖，按需安装：

```bash
npm install react     # 仅当使用 @fancaf/live-sdk/react
npm install vue       # 仅当使用 @fancaf/live-sdk/vue
```

## 快速开始

### 开箱即用（默认 UI）

```js
import { createPlayer } from '@fancaf/live-sdk'
import { mountDefaultUI } from '@fancaf/live-sdk/ui'

const player = createPlayer({
  container: '#player',
  url: 'https://example.com/live.m3u8',
  autoplay: true,
  muted: true,
})

mountDefaultUI(player) // 播放/暂停、静音、音量、清晰度、全屏
```

### 服务端下发地址（PlayConfig Provider）

```js
player.play(async () => {
  const res = await fetch('/api/live/play-config')
  return res.json() // { url, backup, liveStatus, autoplay, muted, poster, quality }
})
```

### React

```jsx
import { useEffect, useState } from 'react'
import { createPlayer } from '@fancaf/live-sdk'
import { usePlayer } from '@fancaf/live-sdk/react'

function Player({ src }) {
  const [player, setPlayer] = useState(null)
  useEffect(() => {
    const p = createPlayer({ container: '#stage', url: src, autoplay: true, muted: true })
    setPlayer(p)
    return () => p.destroy()
  }, [src])
  return player ? <Controls player={player} /> : null
}

function Controls({ player }) {
  const { playing, muted } = usePlayer(player)
  return (
    <button onClick={() => (playing ? player.pause() : player.play())}>
      {playing ? '暂停' : '播放'}
    </button>
  )
}
```

### Vue

```vue
<script setup>
import { ref, onMounted } from 'vue'
import { createPlayer } from '@fancaf/live-sdk'
import { usePlayer } from '@fancaf/live-sdk/vue'

const player = ref(null)
const stage = ref(null)
onMounted(() => {
  player.value = createPlayer({ container: stage.value, url: 'live.m3u8', autoplay: true, muted: true })
})
const state = usePlayer(player) // Ref<PlayerState | null>，就绪前为 null
</script>

<template>
  <div ref="stage" />
  <button v-if="state" @click="state.playing ? player.pause() : player.play()">
    {{ state.playing ? '暂停' : '播放' }}
  </button>
</template>
```

### 无构建（CDN）

```html
<script src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js"></script>
<script src="https://unpkg.com/@fancaf/live-sdk/dist/live-sdk.umd.js"></script>
<script src="https://unpkg.com/@fancaf/live-sdk/dist/live-sdk-ui.umd.js"></script>
<script>
  const { createPlayer } = LiveSdk
  const { mountDefaultUI } = LiveSdkUI
  const player = createPlayer({ container: '#player', url: 'live.m3u8', autoplay: true, muted: true })
  mountDefaultUI(player)
</script>
```

## 核心概念

### 三契约

| 契约 | API | 说明 |
|---|---|---|
| 状态 | `getState()` / `subscribe(cb)` | 低频字段快照；仅在变更时回调 |
| 命令 | `play` `pause` `mute` `setVolume` `switchQuality` `switchURL` `requestFullscreen` `exitFullscreen` `seek` `setPlaybackRate` `setPoster` `setLiveLatency` | 意图式操作 |
| 事件 | `on(name, cb)` / `once` | `first_frame` `manifest_parsed` `features_updated` `error` `live_status` `live_status_error` 等 |
| 查询 | `getStats()` / `bufferInfo()` / `speedInfo()` / `getSessionReport()` | 瞬时指标 vs 会话累计（见下） |

### 状态（PlayerState）

```ts
interface PlayerState {
  playing: boolean
  volume: number
  muted: boolean
  qualities: Quality[]          // 已映射到 streams 的有效档位（含业务原始 label）
  currentQuality: number | null // 当前档位（Quality.id）
  sessionState: SessionState    // 会话真相：idle/loading/ready/playing/paused/stalled/error/ended
  usingBackup: boolean          // 当前是否在播 PlayConfig.backup 备用流
  currentTime: number           // 播放位置；按「整秒变化」节流更新
  duration: number              // 总时长；直播为 Infinity
  fullscreen: boolean           // 兼容标准 Fullscreen API 与 iOS 原生视频全屏
  playbackRate: number          // 当前倍速（经浏览器钳制后读回的真实值）
  capabilities: KernelCapabilities
  [ext: `app.${string}`]: unknown
}
```

> **`playing` 与 `sessionState` 的分工**（卡顿时二者刻意分叉，判错会误报）：
> `playing` 回答「用户看到的是播放还是暂停」—— 转圈、降级提示、埋点分类应判 `sessionState`；
> 播放/暂停**按钮形态**应判 `playing`。
> 卡顿（`stalled`）期间 `playing` 仍为 `true`（已起播、只是缓冲），而 `sessionState` 为 `'stalled'`。
>
> `usingBackup` 的复位点有三处：`play()` 新一轮起播、`switchURL()` 显式换源 → `false`；
> 断流重连切到 `backup`（第 1 次重试）→ `true`。

> 状态快照只放**对直播主场景有意义的低频字段**。播放进度、缓冲区间等高频/可观测数据走 `getStats()` / `bufferInfo()` 或 `player.media` 原生引用，不进快照。

### 能力对齐（getFeatureStatus）

```ts
player.on('features_updated', (report) => {
  // report.features: [{ feature, client, server, matched, detail }]
  // report.summary:  { matched, mismatched }
})
```

`client` 取「SDK + 平台」最弱一侧，`server` 来自 manifest 探测（`EXT-X-PART` / 多 `EXT-X-STREAM-INF` / `EXT-X-KEY`）。

## API

### `createPlayer(config): Player`

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `container` | `string \| HTMLElement` | 必填 | 挂载容器 |
| `url` | `string` | — | 缺省播放地址（动态下发走 `play(provider)`） |
| `kernel` | `KernelConstructor` | 自动选路 | 自定义内核 |
| `hlsConfig` | `object` | — | 透传 hls.js 原生配置 |
| `preset` | `string \| PluginConstructor[]` | `'live'` | 插件组合 |
| `autoplay` | `boolean` | `false` | 构造后自动发起一次 `play()`（需同时给 `url`） |
| `muted` | `boolean` | `false` | 静音 |
| `ignores` | `string[]` | — | 关闭 Preset 内指定功能插件 |
| `network` | `Partial<NetworkConfig>` | 内置 | 网络敏感策略参数 |
| `observability` | `'full' \| 'basic'` | `'full'` | 观测档位 |
| `env` | `EnvAdapter` | `WebEnvAdapter` | 宿主环境适配 |
| `posterMode` | `'native' \| 'overlay'` | `'native'` | 封面图呈现方式；MSE 路径建议 `'overlay'` |

### 命令

| 方法 | 返回 | 说明 |
|---|---|---|
| `play(input?)` | `Promise<void>` | 起播 / 恢复：**无参且已起播过 = 恢复播放**（不重拉流）；带参（URL / `PlayConfig` / provider）= 起播或重新起播 |
| `pause()` | `void` | 暂停 |
| `mute(m)` / `setVolume(v)` | `void` | 静音 / 音量 |
| `switchQuality(id)` | `Promise<void>` | 切清晰度（`Quality.id`；`-1` 恢复自动 ABR）。返回 Promise 是因为内部会 `await` 钩子；语句式调用无需 `await` |
| `switchURL(url)` | `Promise<void>` | 运行中切流（保留会话状态） |
| `requestFullscreen()` / `exitFullscreen()` | `void` | 进入 / 退出全屏（iOS 原生视频全屏亦可退出） |
| `seek(time)` | `void` | 定位（秒），自动钳制到 `[0, duration]`。**直播无限流下为 noop**；点播/重播正常生效 |
| `setPlaybackRate(rate)` | `void` | 设置倍速，写后读回。**直播主场景不建议**（变速会持续累积/消耗延迟）；点播/重播为正常用法 |
| `setPoster(poster?)` | `void` | 运行时更换封面（空值 = 移除）；呈现方式仍由 `posterMode` 决定 |
| `setLiveLatency(target?, max?)` | `void` | 运行时覆盖 LL-HLS 目标延迟；**传空 = 清除覆盖**、恢复 `network` 配置的动态策略 |

`play()` 与 `switchURL()` 语义一致：resolve = 已起播，reject = SDK 尽力后失败（fatal）。可恢复错误走内部自动重连，不会 reject。

> `play()` / `pause()` 会**同步更新** `getState().playing`（不等待浏览器异步派发的 `play` / `pause` 媒体事件），因此 UI 可在命令返回后立即读取快照渲染按钮，不会出现「画面已暂停、按钮仍是播放中」的错位。若需最精确的切换判据，可读 `player.media.paused`。
>
> `playing` 表达的是「**呈现给用户的播放/暂停语义**」而非瞬时会话态：断流重连（`error → retry → loading`）期间按钮**保持**「播放中」图标，不会被退避等待闪回成「播放」；反过来，用户在重连期间按下的暂停也会被尊重，重试成功后不会自动复活为播放。

### 拦截内置逻辑（Hooks）

`useHooks(name, fn)` 可以在内置命令执行前后插入自己的逻辑，最典型的用法是**拦截**：

```js
// 未登录时不允许切清晰度（也可以在这里补一次鉴权后再放行）
player.useHooks('switchQuality', async (ctx) => {
  if (ctx.phase === 'before' && !isLoggedIn()) ctx.cancelled = true
  if (ctx.phase === 'after') report('quality', { id: ctx.id, applied: ctx.applied })
})
```

三个命令已接线：`'play'` / `'switchQuality'` / `'switchURL'`（其余命令目前没有钩子）。约定如下：

| 字段 | 说明 |
|---|---|
| `ctx.phase` | 同名钩子会被调用**两次**：`'before'`（内置逻辑前）与 `'after'`（内置逻辑后） |
| `ctx.cancelled` | **仅 `'before'` 可写**。置 `true` 则跳过内置逻辑，命令直接返回 |
| `ctx.applied` | **仅 `'after'` 可得**。内置逻辑是否真的生效；`false` = 判定为 no-op（如内核不支持切档、`id` 不在档位表里、`play()` 走恢复分支） |
| 入参 | `'play'` → `ctx.input`；`'switchQuality'` → `ctx.id`；`'switchURL'` → `ctx.url` |

`fn` 可以是 async —— **`'before'` 阶段会被 `await`**，因此「先查权限、再放行」这类异步前置判断是可靠的（代价是命令返回时机随之推迟）。`useHooks` 返回解绑函数。

> 为什么用「写回 `ctx`」而不是「返回布尔值」：`HookFn` 的返回类型是 `void | Promise<void>`（钩子不承担返回值契约），所以拦截决策统一走可变上下文。这也让同一个处理器能靠 `ctx.phase` 同时承担前后两个阶段。

### 查询类方法

| 方法 | 说明 |
|---|---|
| `getStats()` / `bufferInfo()` / `speedInfo()` | **瞬时**指标 / 缓冲区间 / 下载速率 |
| `getSessionReport()` | **会话累计**指标：首帧耗时 / 卡顿次数与时长 / 实际播放时长 / 起播时刻 |
| `getFeatureStatus()` | 端到端能力对齐报告（见上） |
| `getLastRetryDiagnostic()` | 最近一次重试诊断快照；无重试时为 `null` |

**为什么累计指标不并入 `getStats()`**：`StatsInfo` 的字段语义是「此刻这一瞬间的播放质量」（码率 / fps / 丢帧），累计量混进去后，「尚未起播」与「值就是 0」在类型上无法区分。因此分三层各归其位：瞬时（`getStats`）/ 累计（`getSessionReport`）/ 低频语义（`PlayerState`）。

```js
player.getSessionReport()
// {
//   firstFrameCost: 812,   // 首帧耗时 ms；尚未出首帧为 null
//   stallCount: 2,         // 本轮会话卡顿次数
//   stallDuration: 3400,   // 累计卡顿时长 ms（进行中的卡顿实时计入）
//   watchTime: 61200,      // 累计「实际播放」时长 ms —— 加载/暂停/卡顿都不计入
//   loadStartTime: 1732000000000, // 本轮起播时刻；从未起播为 null
// }
```

> **会话边界**：由 `play(PlayConfig)` 的**新一轮起播**重置（全部清零）。
> `switchURL()` **不重置**（同一次观看行为换源）；`play()`（无参、恢复播放）也**不重置**（那是续播，不是新会话）。
> 若需要「会话挂钟时长」（含暂停与卡顿），请用 `Date.now() - loadStartTime` 自行计算，不要复用 `watchTime` 承载两种解读。

### 重试诊断（排查用）

可恢复错误由 SDK 自动重连。每次错误 / 重连时，SDK 会采集一份「当前播放地址 + 当前网络环境」快照，随 `error` 事件、`retry` 事件与上报记录三处一起给出，便于线上定位「哪条流、在什么网络下、重试到第几次失败」：

```js
player.on('error', (e) => {
  if (e.fatal) showErrorUI(e)
  console.warn(e.code, e.diagnostic)
  // {
  //   url, primaryUrl, isBackup,          // 本次请求地址 / 主地址 / 是否已切备用流
  //   networkQuality, online, visibility, // good|fair|poor|offline / 在线 / 前后台
  //   effectiveType, downlink, rtt,       // Network Information API（不支持则为 undefined）
  //   bufferBehind, bufferRemaining, currentTime,
  //   retryCount, delay, errorCode, time,
  // }
})
```

同样的快照也会随 `retry` 事件载荷（`e.diagnostic`）与上报插件收到的 `ReportRecord.data.diagnostic` 一起下发——接自定义 `ReporterPlugin` 即可直接转发到埋点/日志系统。

### 事件

`Events` 枚举成员（值即对应 snake_case 字符串，`player.on(Events.FIRST_FRAME, cb)` 与 `player.on('first_frame', cb)` 等价）：

```ts
LOAD_START  MANIFEST_PARSED  FIRST_FRAME  PLAY  PAUSE  PLAYING  STALLED  RECOVERED
RETRY  ERROR  ENDED  QUALITY_CHANGE  ABR_CHANGE  BUFFER_UPDATE  SPEED_UPDATE
VISIBILITY_CHANGE  FEATURES_UPDATED  KERNEL_EVENT
```

插件还会派发两个**独立事件名**（刻意不进 `Events` 枚举 —— 它们属于 `preset: 'live'` 的可选旁路能力，不是播放内核契约的一部分；不接对应配置的接入方永远收不到）：

```ts
'live_status'              // LivePolling：直播状态发生变化
LIVE_STATUS_ERROR_EVENT    // 'live_status_error'：LivePolling 轮询失败
```

#### `PLAY` 与 `PLAYING` 的区别

两者都表示「开始播了」，但处在不同的时间点（与 `<video>` 原生事件语义一致）：

| 事件 | 含义 | 触发时机 |
|---|---|---|
| `PLAY` | 播放**请求**已被内核接受 | `paused` 由 `true` 转 `false` 时（自动播放成功、用户点播、重连后恢复各一次） |
| `PLAYING` | 媒体**真正开始输出** | 首帧可渲染时；每次起播（含换源）都会派发 |

`PLAY` 与 `PAUSE` 严格成对；`PLAYING` 则与 `STALLED` / `RECOVERED` 一起描述播放质量。

#### `BUFFER_UPDATE`：缓冲水位**档位**变化

缓冲水位只随 `timeupdate` / `progress` 变化（~4Hz）。若每次都派发，等于给所有订阅方塞一条 4Hz 高频流；若完全不派发，接入方就只能自开 `setInterval` 轮询 `bufferInfo()`。折中做法是**只在档位跨越边界时**派发：

```js
player.on('buffer_update', (b) => {
  // { level, remaining, length, totalRemaining, totalLength, behind, buffers }
  if (b.level <= 1) showLowBufferHint() // 剩余可播 < 3s
})
```

`level` 由「**当前播放块**的剩余可播时长」在 `BUFFER_LEVEL_THRESHOLDS = [1, 3, 5, 10, 20]`（秒）上分档得出，取值 `0`（最紧张）~ `5`（最充裕）。两个要点：

- **按当前块（`remaining`）而非全量并集（`totalRemaining`）分档** —— 判定「还能不能连续播下去」只取决于当前块；孤岛场景下 buffer 里囤着 30s 但当前块只剩 0.5s 时，真正会发生的是卡顿。
- **载荷带全量 `BufferInfo`**，所以按并集口径或延迟（`behind`）口径判定的接入方也能只订阅这一个事件；需要自定义阈值时直接读原始秒数即可，`BUFFER_LEVEL_THRESHOLDS` 与 `bufferLevelOf()` 均已导出。

查询式接口 `bufferInfo()` 仍然保留，用于「事件之外的按需读取」。

### 直播状态轮询与失败处理（LivePolling）

`preset: 'live'` 内置 `LivePolling`：给了 `PlayConfig.liveStatus` 就按固定间隔轮询，状态**发生变化**时派发结构化 `live_status`（只在变化时派发，避免订阅方反复重渲染）。

**失败语义**：轮询是旁路能力，任何失败都不得影响播放、不得触发重连；但「不打扰」不等于「悄悄死掉」——
早期实现是空 `catch {}`，接入方无法区分下面两种截然不同的处境：

| 处境 | 业务侧观感 |
|---|---|
| 轮询正常，服务端状态确实没变（预期行为） | 「状态一直没变」 |
| 轮询已持续失败、实际上已经死了（故障） | 「状态一直没变」 |

二者观感完全相同，后者会让人相信一个错误的事实。因此现在：

```js
import { LIVE_STATUS_ERROR_EVENT } from '@fancaf/live-sdk'

player.on('live_status', (s) => { /* { status, previousStatus, raw, time } */ })
player.on(LIVE_STATUS_ERROR_EVENT, (e) => {
  // { url, failCount, error, time }
  // failCount：连续失败次数（成功即归零）—— 可据此判断是「偶发抖动」还是「持续故障」
})
```

- **每次失败都有日志**（`logger.warn`，不节流 —— 日志本就是给人排查用的）；
- **失败还经 `live_status_error` 事件外抛**，并按 `failCount` 节流：第 **1** 次立刻上报（故障要马上可见），
  之后取 **3、10** 及每满 **30** 次（30/60/90…），兼顾「持续故障仍有心跳信号」与「长时间断网不刷屏」；
  判据是静态纯函数 `LivePolling.shouldReportFailure(n)`，可单测锚定；
- **独立事件而非并入 `Events.ERROR`**：状态接口 500 不该被记成「直播播放失败」，否则接入方的
  `err.fatal` 兜底分支、错误率统计、Sentry 捕获会被污染；
- **失败按指数退避**：间隔 = `min(interval × 2^failCount, maxInterval)`（`maxInterval` 默认 5 分钟，
  可在 `start()` 前改写），成功一次立即复位为基础间隔 —— 既不放弃，也不按原间隔无脑撞墙；
- **`res.ok` 校验**：`fetch` 对 4xx/5xx 不 reject，不校验 `res.ok` 时「500 + JSON 错误体」既不进
  `catch`、也取不到状态字段，会变成连痕迹都没有的静默失败；
- **状态值显式归一**：`{"status": 0}`（数字）会被 `String()` 归一，否则与字符串 `lastStatus` 恒不相等，
  去重整体失效、每轮都误判为「状态变化」；
- **`stop()` 会清掉待执行句柄并使在途轮次作废**：后台暂停 / 重新 `start()` 后不会留下引用旧地址的野定时器。

| 成员 | 说明 |
|---|---|
| `start(url, interval?)` / `stop()` | 起停轮询（`Player#pollLiveStatus(interval?)` 亦可达） |
| `shouldReportFailure(failCount)` | 静态节流判据 |
| `maxInterval` | 退避间隔上限（ms），默认 `300000` |


## 扩展点

| 扩展 | 用途 |
|---|---|
| `BasePlugin` | 定制行为插件（生命周期 `create/init/ready/destroy`） |
| `UIPlugin` | 界面层插件，挂进 `player.root` |
| `ReporterPlugin` | 自定义上报（`report(record)`） |
| `EnvAdapter` | 宿主环境适配（可见性 / 网络质量，如 App JSBridge） |
| `KernelConstructor` | 自定义媒体内核 |

```ts
class MyReporter extends BasePlugin {
  report(record) {
    navigator.sendBeacon('/log', JSON.stringify(record))
  }
}
createPlayer({ container: '#player', preset: [MyReporter] })
```

## 包结构

| 入口 | 内容 |
|---|---|
| `@fancaf/live-sdk` | 内核 + 三契约 + 插件基类 + 官方 Reporter |
| `@fancaf/live-sdk/ui` | 默认 UI 包（`mountDefaultUI`） |
| `@fancaf/live-sdk/react` | React `usePlayer` |
| `@fancaf/live-sdk/vue` | Vue `usePlayer` |

产物：ESM（`.es.js`）用于现代构建与 SSR；UMD（`.umd.js`）用于 CDN 无构建。本包不提供 CJS（直播播放器无 Node 运行时场景）。

## 兼容性

| 平台 | 内核 | 说明 |
|---|---|---|
| Android / 桌面 Chrome / Edge | `HlsKernel`（hls.js + MSE） | 全能力 |
| iOS Safari 17.1+ / macOS Safari 17.1+ | `HlsKernel`（MMS） | 全能力 |
| iOS Safari < 17.1 | `NativeKernel` | 仅降级播放，深度观测自动落 `basic` |
| iOS 原生 / 无 MSE 环境 | `NativeKernel` | 同上 |

> 前置依赖：`observability: 'full'` 要求平台支持 MSE（iOS/macOS Safari 17.1+ 的 MMS，或标准 MSE）。低于此版本为静态已知边界，直接走 `NativeKernel`，非运行时探测降级。

## 能力边界（Non-Goals）

以下能力是**技术选型下的主动边界收缩**，不是「尚未实现」。**接入前请先对照本表**——若你的业务强依赖其中任意一类，live-sdk 不是合适的选择，建议改用 xgplayer / mpegts.js 等全场景播放器。

按**根因**分为四类，每类共享同一个设计决策：

### 类型一：不做 VOD（时间轴可控的点播场景）

> 根源：live-sdk 是**直播内核**——直播的时间轴受 live edge 约束、不可随意摆布，因此「面向时间轴的相对操作」在**直播态**下不具备语义。`seek` / `setPlaybackRate` 已进入命令集（服务点播 / 重播回放），但在直播无限流下分别表现为 **noop** 与**不建议使用** —— 命令的存在不代表语义边界消失。

| 边界项 | 说明 | 现状 |
|---|---|---|
| **渐进式点播文件**（普通 `.mp4` 直连播放） | 选型 hls.js 单引擎，不做 range 请求/分片加载；「完整 MP4 文件」与选定 fMP4 流式容器是两回事 | 仍不支持：挂 VOD 内核 / `DashKernel`，或改用 mpegts.js |
| **倍速播放（`setPlaybackRate`）** | 直播是无限线性流，变速只会破坏「边缘跟随 / 低延迟」语义——调慢持续累积延迟，调快在缓冲耗尽时反复等待 | 命令已提供；**直播主场景不建议使用**，点播 / 重播回放为正常用法 |
| **定位 / 跳转（`seek`）** | 直播无「跳到某处」语义 | 命令已提供，但**直播无限流（`duration === Infinity`）下为 noop**；点播 / 重播（有限时长）正常生效 |

> **注意**：HLS 点播流（`#EXT-X-ENDLIST`）**是支持的**（走同一内核）；「不做 VOD」特指上表这些**面向时间轴的操作**与**渐进式 `.mp4` 文件**。详见技术规格 §1.3。

### 类型二：只做 HLS 单协议

> 根源：以「单协议做深」换架构简洁——内核层预留扩展点，但不实现其他协议。多协议意味着自带 demux/remux 栈，是数量级的维护成本。

| 不支持 | 说明 | 如需支持 |
|---|---|---|
| **FLV / DASH 协议** | 仅落地 HLS | 实现对应 `Kernel` 并注入 `kernel` 配置 |
| **WebSocket-MP4（`ws://`）** | 非 HTTP 渐进式传输，不在 HLS 范畴 | 同上，需自实现内核 |
| **mkv 容器的音轨 / 字幕抽取** | 无多容器 demux 实现 | 需自研 demux |

### 类型三：能力上限 = 浏览器上限（不做编解码栈）

> 根源：不维护自研解码/编码补齐栈。这层成本被外包给浏览器，换来体积与维护面的数量级缩减——代价是「浏览器不支持的就是不支持」。

| 不支持 | 说明 | 如需支持 |
|---|---|---|
| **H.265 / AV1 软件解码回退** | 无自研解码栈 | 自带 wasm 解码器，或换自研内核 |
| **G.711 / 非标音频编码补齐** | 同上，交由浏览器 | 同上 |

### 类型四：非播放器核心职责（属业务态或平台能力）

> 根源：SDK 只做「把直播播出来」这一件事，不替业务拍板，也不重复造系统能力。

| 不支持 | 说明 | 如需支持 |
|---|---|---|
| **DRM（FairPlay / Widevine / PlayReady）** | 属跨端 + 安全能力；`getFeatureStatus().drm` 恒 `absent` | 接入 EME / 第三方 DRM SDK |
| **弹幕 / 礼物 / 外链等互动** | 业务态能力，SDK 不替业务拍板 | 作为第三方插件接入 |
| **内建字幕 / 投屏 / 画中画控件** | UI 外置；投屏在原生回退路径由系统接管（见 `airplay`） | 自绘 UI / 用系统原生能力 |

### 选型速查

| 你的核心诉求 | 判断 |
|---|---|
| H5 直播 + 干净可控的内核 + 自绘 UI / 跨端复用 | ✅ 适合 live-sdk |
| 只要 HLS 直播，不需要点播/弹幕/投屏全家桶 | ✅ 适合 live-sdk |
| 直播 **+ 点播/回放/短视频** 一体 | ❌ 选 xgplayer（或另挂 VOD 内核） |
| 需要 FLV/DASH/mkv，或客户端软解兜底 | ❌ 选 xgplayer |
| 需要 DRM 版权保护 | ❌ 选带 DRM 的方案 |
| 需要内建弹幕、字幕、投屏等开箱控件 | ❌ 选 xgplayer |

> 与 xgplayer 的逐项差异，见 [对比分析](./docs/vs-xgplayer.md)。

## 文档

- [用户故事（验收用例）](./docs/user-stories.md) —— 45 条用例，格式：目标 / 配置 / 交互 / 预期
- [与 xgplayer 的对比分析](./docs/vs-xgplayer.md) —— 选型边界与逐项差异

## 开发

```bash
npm install
npm run build         # 构建 core / ui / react / vue + 生成 d.ts
npm run verify        # 类型契约校验 + 导出符号校验 + 运行时冒烟
npm run typecheck     # 仅类型检查
```

### 测试

三层分工（详见技术规格 §8.3）：**单测跑 `src` 逻辑，冒烟与 E2E 跑 `dist` 产物**。

```bash
npm test              # Vitest 单测（状态机 / buffer 口径 / 退避策略）
npm run test:watch    # 单测 watch
npm run test:coverage # 单测 + 覆盖率

npm run e2e:install   # 首次拉取 chromium + webkit 内核
npm run e2e           # Playwright E2E（chromium + webkit 两个 project）

npm run verify:all    # 全链路：单测 → 构建 → 冒烟 → E2E
```

> 国内网络拉浏览器内核慢时，可加镜像：
> `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npm run e2e:install`

E2E 覆盖「内核 → Player → UI」的跨层联动（断流重连与去重、近尾 `ended` 判定、Pointer Events、销毁清理），通过注入 `MockKernel` 驱动异常分支，不依赖真实直播流，因此 CI 上稳定不 flaky。选 Playwright 的关键理由之一是它**自带 WebKit**——这是唯一能覆盖 Safari 原生 HLS 回退路径（`NativeKernel`）的引擎。

`npm run verify` 里还有一道**事件活性普查**（`verify/events.mjs`）：逐个统计 `Events` 枚举成员在 `src/` 中的实际 `emit` 派发点，**零派发即构建失败**。加它的原因是「声明了、导出了、`on()` 注册会成功、但永不触发」这类静默失效，类型校验、冒烟、E2E、单测**都拦不住**（详见技术实现档案 §9）。

## 许可

本项目完全自发，采用 [MIT](./LICENSE) 协议 —— 可自由使用、修改、分发，包括商业用途，仅需保留版权与许可声明。

---

# English

live-sdk is a player SDK built for **H5 live-streaming scenarios**. Its kernel ships without UI and without framework bindings — it exposes only three contracts, while UI, reporting, and host-environment adaptation are all added through plugins/adapters. Complexity is encapsulated, customizability is preserved: usable out of the box, yet able to be peeled down layer by layer to a fully custom UI.

Built on **HLS (fMP4/CMAF container) + hls.js**: LL-HLS low latency, ABR and manual quality switching, stream-interruption reconnection, network-quality adaptation, plus built-in **end-to-end capability alignment** (client capabilities × what the server actually provides).

**Language / 语言**: [简体中文](#简体中文) · [English](#english)

## Features

- **Headless kernel**: state / command / event contracts; the UI is an external consumer and can be replaced entirely.
- **Pluggable kernels**: `HlsKernel` (hls.js + MSE / iOS MMS) and `NativeKernel` (Safari native HLS fallback) with automatic routing.
- **LL-HLS low latency**: fMP4 parts (`EXT-X-PART`) with runtime target-latency tuning.
- **Quality / ABR**: automatic ABR plus manual switching; business quality tiers are aligned to the master m3u8 by `height` as the primary key, with index complexity encapsulated inside the SDK.
- **End-to-end capability alignment**: `getFeatureStatus()` reports client-vs-server gaps for `lowLatency` / `abr` / `qualitySwitch` / `drm` / `airplay`.
- **Network adaptation**: target latency, retry count, backoff base, and timeouts are all "static values or dynamically evaluated from network quality".
- **Tiered observability**: `full` (deep collection) / `basic` (standard `<video>` events only), statically configured.
- **Session metrics built in**: `PlayerState.sessionState` (session truth) + `getSessionReport()` (first-frame cost / stall count & duration / watch time), so integrations need not hand-roll the same instrumentation.
- **Plugin extensibility**: `BasePlugin` lifecycle, `UIPlugin` for the view layer, `ReporterPlugin` for reporting, `EnvAdapter` for host adaptation.
- **Framework adapters**: React / Vue `usePlayer` that consume the three contracts with zero intrusion.
- **Build-free usage**: UMD bundles are provided, so a CDN `<script>` tag is all you need.

## Installation

```bash
npm install @fancaf/live-sdk
# or
pnpm add @fancaf/live-sdk
```

`hls.js` is a runtime dependency and is installed automatically. React / Vue adapters are optional peer dependencies — install them on demand:

```bash
npm install react     # only when using @fancaf/live-sdk/react
npm install vue       # only when using @fancaf/live-sdk/vue
```

## Quick Start

### Out of the box (default UI)

```js
import { createPlayer } from '@fancaf/live-sdk'
import { mountDefaultUI } from '@fancaf/live-sdk/ui'

const player = createPlayer({
  container: '#player',
  url: 'https://example.com/live.m3u8',
  autoplay: true,
  muted: true,
})

mountDefaultUI(player) // play/pause, mute, volume, quality, fullscreen
```

### Server-provided URL (PlayConfig Provider)

```js
player.play(async () => {
  const res = await fetch('/api/live/play-config')
  return res.json() // { url, backup, liveStatus, autoplay, muted, poster, quality }
})
```

### React

```jsx
import { useEffect, useState } from 'react'
import { createPlayer } from '@fancaf/live-sdk'
import { usePlayer } from '@fancaf/live-sdk/react'

function Player({ src }) {
  const [player, setPlayer] = useState(null)
  useEffect(() => {
    const p = createPlayer({ container: '#stage', url: src, autoplay: true, muted: true })
    setPlayer(p)
    return () => p.destroy()
  }, [src])
  return player ? <Controls player={player} /> : null
}

function Controls({ player }) {
  const { playing, muted } = usePlayer(player)
  return (
    <button onClick={() => (playing ? player.pause() : player.play())}>
      {playing ? 'Pause' : 'Play'}
    </button>
  )
}
```

### Vue

```vue
<script setup>
import { ref, onMounted } from 'vue'
import { createPlayer } from '@fancaf/live-sdk'
import { usePlayer } from '@fancaf/live-sdk/vue'

const player = ref(null)
const stage = ref(null)
onMounted(() => {
  player.value = createPlayer({ container: stage.value, url: 'live.m3u8', autoplay: true, muted: true })
})
const state = usePlayer(player) // Ref<PlayerState | null>, null until ready
</script>

<template>
  <div ref="stage" />
  <button v-if="state" @click="state.playing ? player.pause() : player.play()">
    {{ state.playing ? 'Pause' : 'Play' }}
  </button>
</template>
```

### Build-free (CDN)

```html
<script src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js"></script>
<script src="https://unpkg.com/@fancaf/live-sdk/dist/live-sdk.umd.js"></script>
<script src="https://unpkg.com/@fancaf/live-sdk/dist/live-sdk-ui.umd.js"></script>
<script>
  const { createPlayer } = LiveSdk
  const { mountDefaultUI } = LiveSdkUI
  const player = createPlayer({ container: '#player', url: 'live.m3u8', autoplay: true, muted: true })
  mountDefaultUI(player)
</script>
```

## Core Concepts

### The three contracts

| Contract | API | Description |
|---|---|---|
| State | `getState()` / `subscribe(cb)` | Low-frequency field snapshot; callbacks fire only on change |
| Commands | `play` `pause` `mute` `setVolume` `switchQuality` `switchURL` `requestFullscreen` `exitFullscreen` `seek` `setPlaybackRate` `setPoster` `setLiveLatency` | Intent-based operations |
| Events | `on(name, cb)` / `once` | `first_frame` `manifest_parsed` `features_updated` `error` `live_status` `live_status_error`, etc. |
| Query | `getStats()` / `bufferInfo()` / `speedInfo()` / `getSessionReport()` | Instantaneous metrics vs. session accumulators (see below) |

### State (PlayerState)

```ts
interface PlayerState {
  playing: boolean
  volume: number
  muted: boolean
  qualities: Quality[]          // effective tiers already mapped to streams (incl. the original business label)
  currentQuality: number | null // current tier (Quality.id)
  sessionState: SessionState    // session truth: idle/loading/ready/playing/paused/stalled/error/ended
  usingBackup: boolean          // whether PlayConfig.backup is currently in use
  currentTime: number           // playback position; throttled to whole-second changes
  duration: number              // total duration; Infinity for live
  fullscreen: boolean           // covers both the standard Fullscreen API and iOS native video fullscreen
  playbackRate: number          // effective rate, read back after browser clamping
  capabilities: KernelCapabilities
  [ext: `app.${string}`]: unknown
}
```

> **How `playing` and `sessionState` divide the work** (they deliberately diverge while stalling —
> judging the wrong one gives wrong reports):
> `playing` answers "does the user see play or pause"; the play/pause **button shape** should read `playing`.
> Spinners, degradation hints and analytics classification should read `sessionState`.
> While stalling, `playing` stays `true` (playback has started, it is only buffering) whereas `sessionState` is `'stalled'`.
>
> `usingBackup` is reset in three places: a fresh `play()` and an explicit `switchURL()` → `false`;
> switching to `backup` during a stall-reconnect (first retry) → `true`.

> The snapshot only holds **low-frequency fields meaningful to the primary live-streaming scenario**. High-frequency or observable data such as playback progress and buffered ranges goes through `getStats()` / `bufferInfo()` or the raw `player.media` reference — never into the snapshot.

### Capability alignment (getFeatureStatus)

```ts
player.on('features_updated', (report) => {
  // report.features: [{ feature, client, server, matched, detail }]
  // report.summary:  { matched, mismatched }
})
```

`client` takes the weaker side of "SDK + platform", while `server` comes from manifest probing (`EXT-X-PART` / multiple `EXT-X-STREAM-INF` / `EXT-X-KEY`).

## API

### `createPlayer(config): Player`

| Field | Type | Default | Description |
|---|---|---|---|
| `container` | `string \| HTMLElement` | required | Mount container |
| `url` | `string` | — | Default playback URL (for dynamic delivery use `play(provider)`) |
| `kernel` | `KernelConstructor` | auto-routed | Custom kernel |
| `hlsConfig` | `object` | — | Pass-through to native hls.js config |
| `preset` | `string \| PluginConstructor[]` | `'live'` | Plugin composition |
| `autoplay` | `boolean` | `false` | Fire one `play()` after construction (requires `url`) |
| `muted` | `boolean` | `false` | Mute |
| `ignores` | `string[]` | — | Disable specific feature plugins inside the Preset |
| `network` | `Partial<NetworkConfig>` | built-in | Network-sensitive policy parameters |
| `observability` | `'full' \| 'basic'` | `'full'` | Observability tier |
| `env` | `EnvAdapter` | `WebEnvAdapter` | Host-environment adapter |
| `posterMode` | `'native' \| 'overlay'` | `'native'` | How the poster is rendered; `'overlay'` recommended on the MSE path |

### Commands

| Method | Returns | Description |
|---|---|---|
| `play(input?)` | `Promise<void>` | Start / resume: **no argument and already started = resume playback** (no re-fetch); with argument (URL / `PlayConfig` / provider) = start or restart |
| `pause()` | `void` | Pause |
| `mute(m)` / `setVolume(v)` | `void` | Mute / volume |
| `switchQuality(id)` | `Promise<void>` | Switch quality (`Quality.id`; `-1` restores auto ABR). Returns a Promise because it awaits hooks; statement-style calls need no `await` |
| `switchURL(url)` | `Promise<void>` | Switch stream at runtime (session state preserved) |
| `requestFullscreen()` / `exitFullscreen()` | `void` | Enter / exit fullscreen (iOS native video fullscreen can also be exited) |
| `seek(time)` | `void` | Seek (seconds), auto-clamped to `[0, duration]`. **No-op on an infinite live stream**; works for VOD / replay |
| `setPlaybackRate(rate)` | `void` | Set playback rate, read back afterwards. **Not recommended for the primary live scenario** (rate changes accumulate/consume latency); fine for VOD / replay |
| `setPoster(poster?)` | `void` | Swap the poster at runtime (empty = remove); rendering still follows `posterMode` |
| `setLiveLatency(target?, max?)` | `void` | Override the LL-HLS target latency at runtime; **passing nothing clears the override** and restores the dynamic policy from `network` |

`play()` and `switchURL()` share the same semantics: resolve = playing, reject = failure after the SDK has done its best (fatal). Recoverable errors go through internal automatic reconnection and will not reject.

> `play()` / `pause()` **synchronously update** `getState().playing` (without waiting for the browser's asynchronously dispatched `play` / `pause` media events), so the UI can read the snapshot immediately after the command returns and render the button — no more "video paused but the button still shows playing". For the most precise switching criterion, read `player.media.paused`.
>
> `playing` expresses the "**play/pause semantics presented to the user**", not a transient session state: during reconnection (`error → retry → loading`) the button **keeps** the "playing" icon and will not flicker back to "play" while waiting for backoff; conversely, a pause pressed by the user during reconnection is respected and will not be revived to playing after a successful retry.

### Intercepting built-in logic (Hooks)

`useHooks(name, fn)` inserts your own logic around a built-in command — most typically to **intercept** it:

```js
// Disallow quality switching while signed out (or run an auth refresh, then let it through)
player.useHooks('switchQuality', async (ctx) => {
  if (ctx.phase === 'before' && !isLoggedIn()) ctx.cancelled = true
  if (ctx.phase === 'after') report('quality', { id: ctx.id, applied: ctx.applied })
})
```

Three commands are wired: `'play'` / `'switchQuality'` / `'switchURL'` (no hooks on the others yet). The conventions:

| Field | Meaning |
|---|---|
| `ctx.phase` | The same hook is called **twice**: `'before'` (before the built-in logic) and `'after'` (after it) |
| `ctx.cancelled` | **Writable in `'before'` only.** Setting `true` skips the built-in logic and returns immediately |
| `ctx.applied` | **`'after'` only.** Whether the built-in logic actually took effect; `false` = resolved to a no-op (kernel lacks quality switching, unknown `id`, or `play()` took the resume branch) |
| Arguments | `'play'` → `ctx.input`; `'switchQuality'` → `ctx.id`; `'switchURL'` → `ctx.url` |

`fn` may be async — **the `'before'` phase is awaited**, so asynchronous gates ("check the permission first, then proceed") are reliable (at the cost of delaying the command's return). `useHooks` returns an unbind function.

> Why write back to `ctx` instead of returning a boolean: `HookFn`'s return type is `void | Promise<void>` (hooks carry no return-value contract), so the interception decision travels through a mutable context. That also lets a single handler serve both phases by branching on `ctx.phase`.

### Query methods

| Method | Description |
|---|---|
| `getStats()` / `bufferInfo()` / `speedInfo()` | **Instantaneous** metrics / buffered ranges / download speed |
| `getSessionReport()` | **Session accumulators**: first-frame cost / stall count & duration / watch time / load start |
| `getFeatureStatus()` | End-to-end capability alignment report (see above) |
| `getLastRetryDiagnostic()` | Most recent retry diagnostic snapshot; `null` when there has been no retry |

**Why the accumulators are not merged into `getStats()`**: `StatsInfo` fields mean "the playback quality at this very instant" (bitrate / fps / dropped frames). Mixing accumulators in makes "not started yet" and "the value really is 0" indistinguishable at the type level. Hence three separate homes: instantaneous (`getStats`) / cumulative (`getSessionReport`) / low-frequency semantic (`PlayerState`).

```js
player.getSessionReport()
// {
//   firstFrameCost: 812,   // ms; null until the first frame is available
//   stallCount: 2,         // stall episodes this session
//   stallDuration: 3400,   // accumulated stall ms (an in-progress stall counts live)
//   watchTime: 61200,      // accumulated *actually playing* ms — loading/paused/stalled excluded
//   loadStartTime: 1732000000000, // session load start; null if never started
// }
```

> **Session boundary**: reset by a fresh `play(PlayConfig)` (everything zeroed).
> `switchURL()` does **not** reset (same viewing session, different source); `play()` with no argument (resume) does **not** reset either (that is a resume, not a new session).
> If you need "session wall-clock duration" (including pauses and stalls), compute `Date.now() - loadStartTime` yourself rather than reusing `watchTime` for two meanings.

### Retry diagnostics (for troubleshooting)

Recoverable errors are reconnected automatically by the SDK. On every error / reconnection, the SDK captures a "current playback URL + current network environment" snapshot and delivers it in three places — the `error` event, the `retry` event, and the report record — making it easy to locate in production "which stream, on what network, and at which retry attempt it failed":

```js
player.on('error', (e) => {
  if (e.fatal) showErrorUI(e)
  console.warn(e.code, e.diagnostic)
  // {
  //   url, primaryUrl, isBackup,          // requested URL / primary URL / whether backup was used
  //   networkQuality, online, visibility, // good|fair|poor|offline / online / foreground-background
  //   effectiveType, downlink, rtt,       // Network Information API (undefined if unsupported)
  //   bufferBehind, bufferRemaining, currentTime,
  //   retryCount, delay, errorCode, time,
  // }
})
```

The same snapshot is also delivered with the `retry` event payload (`e.diagnostic`) and to reporting plugins as `ReportRecord.data.diagnostic` — wire up a custom `ReporterPlugin` and forward it straight to your analytics/logging system.

### Events

`Events` enum members (values are the corresponding snake_case strings, so `player.on(Events.FIRST_FRAME, cb)` is equivalent to `player.on('first_frame', cb)`):

```ts
LOAD_START  MANIFEST_PARSED  FIRST_FRAME  PLAY  PAUSE  PLAYING  STALLED  RECOVERED
RETRY  ERROR  ENDED  QUALITY_CHANGE  ABR_CHANGE  BUFFER_UPDATE  SPEED_UPDATE
VISIBILITY_CHANGE  FEATURES_UPDATED  KERNEL_EVENT
```

Plugins additionally dispatch two **standalone event names** (deliberately kept out of the `Events` enum — they belong to the optional side-channel provided by `preset: 'live'`, not to the playback kernel contract; integrations that never configure them will never receive them):

```ts
'live_status'              // LivePolling: live status changed
LIVE_STATUS_ERROR_EVENT    // 'live_status_error': LivePolling request failed
```

#### `PLAY` vs `PLAYING`

Both mean "playback started", but at different points in time (mirroring the native `<video>` event semantics):

| Event | Meaning | Fires when |
|---|---|---|
| `PLAY` | the play **request** has been accepted by the kernel | `paused` flips `true` → `false` (autoplay success, user tap, post-reconnect resume) |
| `PLAYING` | the media is **actually rendering** | first frame is presentable; every start (including source switches) |

`PLAY` is strictly paired with `PAUSE`; `PLAYING` pairs with `STALLED` / `RECOVERED` to describe playback quality.

#### `BUFFER_UPDATE`: buffer-level **bucket** changes

Buffer levels only change on `timeupdate` / `progress` (~4 Hz). Emitting on every tick would push a 4 Hz stream to every subscriber; emitting never would force integrations to `setInterval`-poll `bufferInfo()`. The middle ground is to emit **only when the level crosses a bucket boundary**:

```js
player.on('buffer_update', (b) => {
  // { level, remaining, length, totalRemaining, totalLength, behind, buffers }
  if (b.level <= 1) showLowBufferHint() // less than 3s of playable data left
})
```

`level` is derived from the **current playback block's** remaining playable time, bucketed on `BUFFER_LEVEL_THRESHOLDS = [1, 3, 5, 10, 20]` (seconds), ranging from `0` (tightest) to `5` (most comfortable). Two things to note:

- **Bucketed on the current block (`remaining`), not the union (`totalRemaining`)** — whether playback can continue depends solely on the current block. In an island scenario where 30s is buffered elsewhere but only 0.5s remains in the current block, a stall is what actually happens.
- **The payload carries the full `BufferInfo`**, so integrations judging by the union or by latency (`behind`) can live off this one event. For custom thresholds, read the raw seconds — `BUFFER_LEVEL_THRESHOLDS` and `bufferLevelOf()` are both exported.

The query-style `bufferInfo()` remains available for on-demand reads outside the event.

### Live status polling and failure handling (LivePolling)

`preset: 'live'` bundles `LivePolling`: give it a `PlayConfig.liveStatus` and it polls at a fixed interval, dispatching a structured `live_status` **only when the status changes** (deduplication keeps subscribers from re-rendering on every tick).

**Failure semantics**: polling is a side-channel — a failure must never affect playback or trigger a reconnect. But "not disruptive" is not the same as "dies quietly":

| Situation | What the integration sees |
|---|---|
| Polling works, the server status simply has not changed (expected) | "the status never changed" |
| Polling has been failing continuously and is effectively dead (a fault) | "the status never changed" |

The two are indistinguishable, so the latter makes you believe a false fact. Therefore:

```js
import { LIVE_STATUS_ERROR_EVENT } from '@fancaf/live-sdk'

player.on('live_status', (s) => { /* { status, previousStatus, raw, time } */ })
player.on(LIVE_STATUS_ERROR_EVENT, (e) => {
  // { url, failCount, error, time }
  // failCount: consecutive failures (reset to 0 on success) — tells jitter from a sustained outage
})
```

- **Every failure is logged** (`logger.warn`, unthrottled — logs exist to be read by humans);
- **Failures are also surfaced via the `live_status_error` event**, throttled by `failCount`: the **1st** failure
  is reported immediately (a fault must be visible at once), then the **3rd**, **10th** and every 30th (30/60/90…)
  afterwards — balancing "a sustained outage still emits a heartbeat signal" against "a long offline period
  must not flood the reporting channel". The predicate is the static pure function
  `LivePolling.shouldReportFailure(n)`, unit-testable;
- **A standalone event rather than folding into `Events.ERROR`**: a 500 on the status endpoint must not be
  recorded as "live playback failed", or the integration's `err.fatal` fallback branch, error-rate metrics
  and Sentry capture all get polluted;
- **Exponential backoff on failure**: interval = `min(interval × 2^failCount, maxInterval)` (`maxInterval`
  defaults to 5 minutes and can be set before `start()`), reset to the base interval as soon as one request
  succeeds — neither giving up nor hammering at a fixed interval;
- **`res.ok` validation**: `fetch` does not reject on 4xx/5xx, so without checking `res.ok` a
  "500 + JSON error body" neither enters `catch` nor yields a status field — a silent failure with no trace at all;
- **Explicit status normalisation**: `{"status": 0}` (a number) is coerced with `String()`, otherwise it never
  equals the string `lastStatus`, deduplication breaks entirely and every tick is misread as "status changed";
- **`stop()` clears the pending handle and voids the in-flight round**: pausing on background / re-`start()`
  leaves no stray timer pointing at a stale URL.

| Member | Description |
|---|---|
| `start(url, interval?)` / `stop()` | Start / stop polling (also reachable via `Player#pollLiveStatus(interval?)`) |
| `shouldReportFailure(failCount)` | Static throttling predicate |
| `maxInterval` | Backoff ceiling in ms, default `300000` |


## Extension Points

| Extension | Purpose |
|---|---|
| `BasePlugin` | Custom behavior plugin (lifecycle `create/init/ready/destroy`) |
| `UIPlugin` | View-layer plugin, mounted into `player.root` |
| `ReporterPlugin` | Custom reporting (`report(record)`) |
| `EnvAdapter` | Host-environment adaptation (visibility / network quality, e.g. App JSBridge) |
| `KernelConstructor` | Custom media kernel |

```ts
class MyReporter extends BasePlugin {
  report(record) {
    navigator.sendBeacon('/log', JSON.stringify(record))
  }
}
createPlayer({ container: '#player', preset: [MyReporter] })
```

## Package Structure

| Entry | Contents |
|---|---|
| `@fancaf/live-sdk` | Kernel + three contracts + plugin base classes + official Reporter |
| `@fancaf/live-sdk/ui` | Default UI package (`mountDefaultUI`) |
| `@fancaf/live-sdk/react` | React `usePlayer` |
| `@fancaf/live-sdk/vue` | Vue `usePlayer` |

Bundles: ESM (`.es.js`) for modern builds and SSR; UMD (`.umd.js`) for build-free CDN usage. This package does not ship CJS (a live-streaming player has no Node runtime scenario).

## Compatibility

| Platform | Kernel | Notes |
|---|---|---|
| Android / desktop Chrome / Edge | `HlsKernel` (hls.js + MSE) | Full capability |
| iOS Safari 17.1+ / macOS Safari 17.1+ | `HlsKernel` (MMS) | Full capability |
| iOS Safari < 17.1 | `NativeKernel` | Degraded playback only; deep observability automatically falls back to `basic` |
| Native iOS / no-MSE environments | `NativeKernel` | Same as above |

> Prerequisite: `observability: 'full'` requires the platform to support MSE (MMS on iOS/macOS Safari 17.1+, or standard MSE). Below that version it is a statically known boundary — the SDK goes straight to `NativeKernel`, not a runtime-probed downgrade.

## Capability Boundaries (Non-Goals)

The following capabilities are **deliberate boundary contractions of the technical choices**, not "not yet implemented". **Check this table before integrating** — if your business strongly depends on any category below, live-sdk is not the right fit, and a full-scenario player such as xgplayer / mpegts.js would serve you better.

Grouped by **root cause** into four categories; each category shares a single design decision:

### Category 1: No VOD (controllable-timeline playback)

> Root cause: live-sdk is a **live-streaming kernel** — a live timeline is constrained by the live edge and cannot be freely positioned, so "operations relative to the timeline" carry no meaning **in the live state**. `seek` / `setPlaybackRate` have entered the command set (to serve VOD / replay playback), but on an infinite live stream they are a **no-op** and **not recommended** respectively — a command existing does not erase the semantic boundary.

| Boundary item | Notes | Status |
|---|---|---|
| **Progressive VOD files** (plain `.mp4` direct playback) | A single-engine hls.js choice that does not do range requests / segment loading; "a complete MP4 file" and the chosen fMP4 streaming container are two different things | Still unsupported: attach a VOD kernel / `DashKernel`, or switch to mpegts.js |
| **Playback rate (`setPlaybackRate`)** | Live is an infinite linear stream; changing rate only breaks the "edge following / low latency" semantics — slowing down accumulates latency, speeding up repeatedly stalls when the buffer runs dry | Command provided; **not recommended for the primary live scenario**, fine for VOD / replay |
| **Positioning / seeking (`seek`)** | Live has no "jump to a position" semantics | Command provided, but a **no-op on an infinite live stream (`duration === Infinity`)**; works for VOD / replay (finite duration) |

> **Note**: HLS VOD streams (`#EXT-X-ENDLIST`) **are supported** (through the same kernel); "no VOD" here specifically means the **timeline-relative operations** above and **progressive `.mp4` files**. See the technical specification §1.3.

### Category 2: HLS single protocol only

> Root cause: trading breadth for architectural simplicity — "go deep on one protocol". The kernel layer reserves extension points but implements nothing else. Multi-protocol means carrying your own demux/remux stack, an order-of-magnitude maintenance cost.

| Not supported | Notes | If you need it |
|---|---|---|
| **FLV / DASH protocols** | Only HLS is implemented | Implement the corresponding `Kernel` and inject it via the `kernel` config |
| **WebSocket-MP4 (`ws://`)** | Not HTTP progressive transfer; outside the HLS scope | Same as above — a custom kernel is required |
| **mkv container audio-track / subtitle extraction** | No multi-container demux implementation | A custom demux is required |

### Category 3: Ceiling = the browser's ceiling (no codec stack)

> Root cause: no in-house decoding / codec-filling stack is maintained. That cost is outsourced to the browser in exchange for an order-of-magnitude reduction in size and maintenance surface — at the price that "what the browser cannot do, we cannot do".

| Not supported | Notes | If you need it |
|---|---|---|
| **H.265 / AV1 software-decoding fallback** | No in-house decoding stack | Supply your own wasm decoder, or switch to a self-built kernel |
| **G.711 / non-standard audio codec filling** | Same as above — delegated to the browser | Same as above |

### Category 4: Not a player's core responsibility (business-domain or platform capabilities)

> Root cause: the SDK does exactly one thing — "get the live stream playing". It does not make business calls for you, nor reinvent system capabilities.

| Not supported | Notes | If you need it |
|---|---|---|
| **DRM (FairPlay / Widevine / PlayReady)** | A cross-platform + security capability; `getFeatureStatus().drm` is always `absent` | Integrate EME / a third-party DRM SDK |
| **Danmaku / gifts / outbound links and other interactions** | Business-domain capabilities; the SDK does not make those calls for you | Integrate as third-party plugins |
| **Built-in subtitle / casting / picture-in-picture controls** | UI is externalized; casting is taken over by the system on the native fallback path (see `airplay`) | Draw your own UI / use native system capabilities |

### Quick selection guide

| Your core requirement | Verdict |
|---|---|
| H5 live + a clean, controllable kernel + custom UI / cross-platform reuse | ✅ live-sdk fits |
| HLS live only, no need for the VOD / danmaku / casting bundle | ✅ live-sdk fits |
| Live **plus** VOD / replay / short video in one | ❌ Choose xgplayer (or attach a VOD kernel) |
| FLV / DASH / mkv, or client-side software-decoding fallback | ❌ Choose xgplayer |
| DRM content protection | ❌ Choose a DRM-capable solution |
| Built-in danmaku, subtitles, casting and other ready-made controls | ❌ Choose xgplayer |

> For an item-by-item comparison with xgplayer, see [the analysis](./docs/vs-xgplayer.md).

## Documentation

- [User stories (acceptance cases)](./docs/user-stories.md) — 45 cases in the format: goal / config / interaction / expectation
- [Comparison with xgplayer](./docs/vs-xgplayer.md) — selection boundaries and an item-by-item difference list

## Development

```bash
npm install
npm run build         # build core / ui / react / vue + generate d.ts
npm run verify        # type-contract check + export-symbol check + runtime smoke
npm run typecheck     # type checking only
```

### Testing

Three-tier separation (see technical specification §8.3): **unit tests run against `src` logic; smoke and E2E run against the `dist` artifacts.**

```bash
npm test              # Vitest unit tests (state machine / buffer semantics / backoff / polling failures / session metrics)
npm run test:watch    # unit tests in watch mode
npm run test:coverage # unit tests + coverage

npm run e2e:install   # first-time fetch of the chromium + webkit engines
npm run e2e           # Playwright E2E (two projects: chromium + webkit)

npm run verify:all    # full chain: unit tests → build → smoke → E2E
```

> If fetching browser engines is slow on your network, use a mirror:
> `PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npm run e2e:install`

E2E covers the cross-layer chain "kernel → Player → UI" (reconnection and de-duplication, near-tail `ended` detection, Pointer Events, destroy cleanup). It drives the failure branches by injecting a `MockKernel` rather than depending on a real live stream, so it is stable and non-flaky in CI. One key reason for choosing Playwright is that it **ships WebKit** — the only engine that can cover Safari's native HLS fallback path (`NativeKernel`).

`npm run verify` also runs an **events liveness census** (`verify/events.mjs`): it counts the actual `emit` sites for every `Events` enum member across `src/`, and **fails the build on zero dispatch sites**. It exists because silent failures of the form "declared, exported, `on()` succeeds, but never fires" slip past type checks, smoke tests, E2E and unit tests alike (see the implementation dossier §9).

## License

This project is entirely self-initiated and released under the [MIT](./LICENSE) license — free to use, modify, and distribute, including for commercial purposes, requiring only that the copyright and license notice be retained.
