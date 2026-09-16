# live-sdk 技术实现档案

> **基线**：v0.4.0 —— `src/` 共 29 个 TS 文件（`core/Player.ts` 1521 行）。
> 本文中所有「文件:行」引用均以该版本为准；行号会随源码改动漂移，对不上时**以方法名/标识符为准**。
>
> **版本沿革与本文覆盖范围**：
> | 版本 | 提交 | 本文覆盖 |
> |---|---|---|
> | 0.1.0 | `51202c4` | 基线（首次发布） |
> | 0.2.0 | `3b567e8` | §8.2 |
> | 0.3.0 | `ca34c46` | §8.3 |
> | **0.4.0** | （事件活性 + Hooks 接线） | **§8.5、§5.3、§9** —— 本轮补充 |

---

## 0. 这份文档是什么

工程里同时存在三份文档，分工不同，阅读时不要混淆：

| 文档 | 位置 | 回答的问题 | 读者 |
|---|---|---|---|
| **技术规格（spec）** | `m-player/docs/live-sdk-spec.md` | 打算做成什么样（Goals / Non-Goals / 模块设计 / 机制设计） | 设计阶段 |
| **README** | `live-sdk/README.md` | 怎么用（API 表、配置项、FAQ、选型边界） | 接入方 |
| **本文（实现档案）** | 本文件 | 实际做成了什么样、**每处为什么这么做**、哪些地方留了缺口 | 维护者 / 通读者 |

三者的关系是「**意图 → 用法 → 实现**」。spec 描述的是设计意图；实现过程中发现意图在某些边界上不足，于是补边——**这些补边的原因，就是本文第 8 节「变更档案」的主体**。

### 关于源码里的 `§x.y` 引用

`src/` 中有 21 处形如 `（§3.6）`、`见 §7.2` 的注释引用，**它们指向的是 spec（`m-player/docs/live-sdk-spec.md`）的章节号，不是本仓库的文件**。该 spec 位于母仓库，未随 live-sdk 独立仓库发布 —— 因此：

- 在独立仓库里通读代码时，这些章节号**无法就地跳转**，属于已知的引用漂移（见 §9.4）；
- 本文在每个对应位置尽量把 spec 的原意复述一遍，使本文可独立阅读。

### 一句话路线图

想快速抓住重点：**§2 三契约 → §3 会话语义 → §5.3 Hooks → §8 变更档案（为什么长这样）→ §9 缺口与已处置项**。
§4（内核）/§6（可观测）/§7（稳定性）是机制细节，按需查阅。

---

## 1. 架构的落地形态

### 1.1 分层与文件映射

spec §2.2 给的是概念分层，实际文件落位如下：

```
接入层    src/index.ts                    createPlayer 工厂 + 全部导出面（80 行）
────────────────────────────────────────────────────────────────────────
核心层    src/core/Player.ts              组装与编排（1385 行，唯一的"大文件"）
          src/core/StateMachine.ts        显式状态表（69 行，纯逻辑无依赖）
          src/core/StateStore.ts          状态快照 + 全量订阅（37 行）
          src/core/MediaProxy.ts          原生 <video> 抽象（156 行）
          src/core/EventBus.ts            事件发布订阅（52 行）
          src/core/Hooks.ts               内置逻辑钩子（31 行）
          src/core/PluginManager.ts       插件生命周期调度（86 行）
          src/core/BasePlugin.ts          插件基类（49 行）
────────────────────────────────────────────────────────────────────────
内核层    src/kernel/HlsKernel.ts        hls.js 封装（197 行）
          src/kernel/NativeKernel.ts     原生回退（78 行）
────────────────────────────────────────────────────────────────────────
契约层    src/types.ts                    三方契约的唯一来源（468 行）
          src/constants.ts                Events / ERROR_CODE / 默认策略（91 行）
────────────────────────────────────────────────────────────────────────
基础层    src/utils/*                     config·logger·errors·retry·buffer·features·sniffer
          src/env/WebEnvAdapter.ts        宿主环境适配（51 行）
────────────────────────────────────────────────────────────────────────
外置 UI   src/ui/*                        UIMount + 5 个控件（非内核一部分）
          src/adapters/react.ts|vue.ts    框架适配（各 25 / 44 行）
上报      src/reporter/ConsoleReporter.ts|SentryReporter.ts
功能插件  src/plugins/LivePolling.ts      直播状态轮询（207 行）
```

两点值得注意的**边界事实**：

1. **`<video>` 由内核创建并持有**（`MediaProxy` 在 `Player` 构造函数里 `document.createElement('video')`）。headless 指的是「不预设 UI 控件层」，不是「不碰 DOM」——声音、画面、MSE 都依赖这个元素。接入方通过 `player.media` 拿引用，但创建权不开放。
2. **`src/ui/` 不依赖 `src/core/` 的内部**，只通过 `subscribe()` + 命令方法两条通道连接 `Player`（`ui/UIPlugin.ts:27`）。

### 1.2 Player 的装配顺序（`core/Player.ts:142-205`）

构造函数是理解全局装配的入口，9 步依次为：

| 步 | 动作 | 要点 |
|---|---|---|
| 1 | 解析容器 | `resolveContainer`：字符串走 `querySelector`，失败即抛 |
| 2 | 配置三层合并 | `deepMerge(DEFAULT_CONFIG, config)`；`network` **再单独合并一次** `DEFAULT_NETWORK_STRATEGY`，否则用户只传 `{ retryCount }` 时其余字段会丢失 |
| 3 | 建 root + video | root 是 `position:relative` 的容器，video 绝对定位铺满 |
| 4 | env 适配器 | `config.env ?? new WebEnvAdapter()` |
| 5 | 状态快照初值 | 与 `StateMachine` 初值（`idle`）对齐 |
| 6 | PluginManager | 持有 `this`（循环引用由类型层解决） |
| 7 | 装载 preset | `applyPreset()` 读 `config.preset` + `config.ignores` |
| 8 | 绑定事件 | `bindEnv()` → `stateMachine.onChange()` → `bindMediaEvents()`，**顺序不可换**：状态机监听必须在 media 事件绑定之前挂上 |
| 9 | 缺省地址自动起播 | 仅当 `config.url && config.autoplay` 同时成立 |

**为什么 `Player.ts` 会膨胀到 1385 行**：它是唯一持有全部运行期状态的地方（`playRequestId` / `retryCount` / `qualityMap` / `session*` / `timers` / `latencyOverride` …），所有跨子系统的协调都写在这里。可拆分的是「内部机制」段（清晰度映射、能力探测、诊断采集），它们与 Player 的私有状态强耦合，拆出需先决定状态的归属——建议在扩充功能前处理，而非等到 2000 行。

---

## 2. 三契约的实现

### 2.1 命令契约

`PlayerCommands`（`types.ts:208-255`）共 **12 个命令**，实现全部落在 `Player` 的同名方法上：

| 命令 | 实现要点 |
|---|---|
| `play(input?)` | **双语义**：无参且 `hasLoaded` → 走「恢复播放」分支（不重新拉流，直播不该重建 buffer）；否则解析配置起播。前后各派发一次 `'play'` 钩子（§5.3） |
| `pause()` | 乐观更新：先同步置 `playing:false` + `playIntent:false`，随后到达的 media `pause` 事件做幂等确认 |
| `mute(m)` / `setVolume(v)` | 写 MediaProxy 后同步快照 |
| `switchQuality(id)` | `id=-1` 走 ABR（`currentQuality: null` + `ABR_CHANGE`）；否则经 `qualityMap` 转 hls.js level 索引。**返回 `Promise<void>`**（内部 `await` before 钩子），见 §5.3 |
| `switchURL(url)` | 换源，**不重置会话统计**，但复位 `usingBackup`。同样有 `'switchURL'` 钩子 |
| `requestFullscreen()` / `exitFullscreen()` | 委托 MediaProxy，两条平台路径见 §4.5 |
| `seek(time)` | **直播无限流下 noop**（`duration` 非有限即 return）；点播/重播态钳制到 `[0, duration]`，并同步纠正 `progressSecond` 游标 |
| `setPlaybackRate(rate)` | 写后读回（浏览器可能钳制）；非法入参 catch 后忽略 |
| `setPoster(poster?)` | 空值 = 移除；呈现方式仍由 `posterMode` 决定 |
| `setLiveLatency(target?, max?)` | 写入 `latencyOverride`，**两参皆缺省即清除覆盖**、回落 `config.network` 的动态策略；内核不支持则静默忽略 |

> **语义边界的处理原则**：`seek` / `setPlaybackRate` 在直播主场景下"命令存在但语义受限"，实现层用 `noop` + `logger.debug` 而非抛错——因为同一份接入代码可能同时服务直播与重播两种状态，抛错会迫使业务侧到处写 `if`。

### 2.2 状态契约

`StateStore`（37 行）是极简实现：全量快照、浅拷贝读、`set(patch)` 合并后**通知全部订阅者**（无字段级 diff）。

**关键设计原则：快照只放低频字段。** 这条原则决定了 `PlayerState` 的分层：

```ts
interface PlayerState {
  // —— 会话/用户语义（低频，变更偶发）——
  playing, sessionState, currentTime, duration, fullscreen, playbackRate,
  volume, muted,
  // —— 档位 ——
  qualities, currentQuality,
  // —— 平台能力 ——
  capabilities,
  // —— 流来源状态 ——
  usingBackup,
  // —— 扩展位 ——
  [ext: `app.${string}`]: unknown
}
```

共 **12 个显式字段**（外加 `app.*` 索引扩展位）。其中 `sessionState / usingBackup / currentTime / duration / fullscreen / playbackRate` 六个是 v0.3.0 新增——**新增位置全部落在"低频语义"区，没有把任何高频量塞进快照**，这是上面那条原则的直接体现。

`currentTime` 是唯一的高频源，用**「整秒变化才写」**节流（`syncProgress()`，`Player.ts:1112-1123`）：`timeupdate` 约 4Hz，直写会让 React/Vue 订阅方每秒重渲染 4 次。逐帧精度场景走 `player.media.currentTime`。

其余高频/可观测数据一律不进快照，走查询式接口（见 §6.1 的三层出口）。

### 2.3 事件契约

`Events` 枚举 18 个成员，值即 snake_case 字符串，因此 `on(Events.FIRST_FRAME, cb)` 与 `on('first_frame', cb)` 等价。

**实际派发点全表**（程序化普查所得，已由 `verify/events.mjs` 持续守护 —— 枚举成员零派发即构建失败）：

| 事件 | emit 数 | 位置 |
|---|---|---|
| `LOAD_START` | 2 | 起播 `:277`、重连 `:1273` |
| `MANIFEST_PARSED` | 1 | `:811`（含原生回退路径经 `loadedmetadata` 触发） |
| `FIRST_FRAME` | 1 | `:1017` |
| `PLAY` | 1 | `:917` —— **挂 media `play` 事件**，与 `PAUSE` 对称（v0.4.0 补齐，见 §8.5） |
| `PAUSE` | 2 | `:952`（状态机迁移成功）、`:959`（迁移未覆盖时按媒体真实态兜底） |
| `PLAYING` | 1 | `:930` |
| `STALLED` | 1 | `:976` |
| `RECOVERED` | 1 | `:926` |
| `RETRY` | 1 | `:1253` |
| `ERROR` | 1 | `:1215` |
| `ENDED` | 3 | `:863`、`:972`、`:985`（正常结束 / 近尾判完 / 超时前近尾） |
| `QUALITY_CHANGE` | 1 | `:336` |
| `ABR_CHANGE` | 2 | `:329`（切自动）、`:793`（内核 level_switched 透传） |
| `BUFFER_UPDATE` | 1 | `:512` —— **挂 media `progress` + 档位跨越判定**（v0.4.0 补齐，见 §8.5） |
| `SPEED_UPDATE` | 1 | `:799`（挂在 `frag_loaded` 上） |
| `VISIBILITY_CHANGE` | 1 | `:1361` |
| `FEATURES_UPDATED` | 1 | `:812` |
| `KERNEL_EVENT` | 2 | `:784`（内核事件统一透传）、`:1369`（网络变化） |

> **这张表在 0.4.0 之前有两个 0**：`PLAY` 与 `BUFFER_UPDATE` 声明并导出，却全仓库零 `emit`。
> 两者已在 v0.4.0 接上触发时机，并新增 `verify/events.mjs` 把这类静默失效转为构建失败 ——
> 完整的问题成因分析见 §9.3。

`EventBus.emit` 对每个回调做 `try/catch`（`EventBus.ts:38-44`），单个订阅者抛错不影响其他订阅者，也不上抛给接入方——这是对的，但意味着**订阅者内的错误只会出现在 console**。

`LivePolling` 另派发两个**不在枚举内**的独立事件名（旁路能力，不接 `PlayConfig.liveStatus` 的接入方永远收不到）：
`'live_status'`（`:145`）与 `'live_status_error'`（`:183`，常量 `LIVE_STATUS_ERROR_EVENT` 已从根导出）。

### 2.4 业务态扩展：`app.*`

`setAppState()`（`:400-412`）只接受 `app.` 前缀键，非前缀**忽略并告警**而非抛错——运行时兜底，防止无类型约束的 JS 调用方覆盖 `playing` 等内核字段。空 patch 直接返回，不触发订阅（`state.set` 无条件通知，故必须提前拦截）。

---

## 3. 状态机与会话语义

### 3.1 状态表（`core/StateMachine.ts:24-39`）

8 个会话态、**显式状态表**驱动（非 if-else 串行判断）：

```
idle    --load--> loading
loading --manifestParsed--> ready    | --error--> error
ready   --play--> playing
playing --pause--> paused | --stall--> stalled | --ended--> ended | --error--> error
paused  --play--> playing | --ended--> ended
stalled --recovered--> playing | --pause--> paused | --timeout--> error | --ended--> ended
error   --retry--> loading | --ended--> ended
ended   --play--> playing | --load--> loading
```

**相对 spec §3.3 表格新增了两条边**，两条都不是可选项：

- **`stalled → pause`**：spec 的状态表只给了 `stalled → recovered / timeout`。缺这条边时，用户「卡顿期间按暂停」会让 `transition('pause')` 返回 false，落到 `onMediaPause` 的兜底分支——兜底分支只翻转 `playing` 快照，**状态机停在 `stalled`**。后果有两个：`sessionState` 与事实不符（用户在暂停，却报「卡顿中」）；且「进行中的卡顿时长」永远得不到结算（少计）。这在只有 `playing` 一个字段时不可见，一旦把 `sessionState` 暴露出去就立刻暴露。
- **`stalled → ended`**：近尾卡顿的语义是「播完」而非「停滞待重连」。部分内核（尤其 Android WebView 解码器）在接近末尾时停止推进，但 buffer 其实够播完，且不派发 `ended`。判据是 `isNearTail()`（`:864-875`）：最后缓冲区间末端 ≈ `duration` 且播放点也贴近末尾，直播无限流恒 false。

### 3.2 为什么 `sessionState` 与 `playing` 必须分开

这是 v0.3.0 引入 `sessionState` 时最需要说清的一点 —— **两者在卡顿时刻意分叉**：

| 字段 | 回答的问题 | `stalled` 期间取值 |
|---|---|---|
| `playing` | 用户看到的是「播放」还是「暂停」——**呈现语义** | `true`（已起播，只是缓冲，按钮该显示"播放中"） |
| `sessionState` | 播放器内部此刻处于什么阶段——**事实语义** | `'stalled'` |

在只有 `playing` 的时代，这个分叉信息**存在于状态机内部但对外不可见**，接入方只能自行猜测（典型误判：把卡顿当成正常播放，或反过来在重连退避期间闪回"播放"图标）。

使用约定（已写入 `types.ts:264-286` 的类型注释）：
- 播放/暂停**按钮形态** → 判 `playing`；
- 转圈提示、降级提示、埋点分类、"是正常播放还是卡住了" → 判 `sessionState`。

### 3.3 两个补充标志

`playing` 快照并非 `sessionState` 的机械映射，它由两个私有标志共同决定：

- **`playIntent`**（`:96`）：用户/业务「想不想播」。断流重连会把会话态推离 `playing`（`playing → stall → stalled → timeout → error → retry → loading`），但**意图仍是播放**。若快照机械跟随状态机，按钮会在指数退避等待期间（可达数秒）闪回"播放"图标。
  - 置 `true`：显式 `play()`、媒体 `playing` 事件
  - 置 `false`：显式 `pause()`、媒体 `pause` 事件、`ended`
- **`mediaPaused`**（`:89`）：媒体真实暂停态的兜底标志，用于状态机未覆盖的迁移路径。

`onStateChange`（`:1029-1062`）中的取值规则：

| 会话态 | `playing` |
|---|---|
| `playing` | `true` |
| `stalled` | `!mediaPaused` |
| `paused` / `ended` | `false` |
| `loading` / `error` / `ready` / `idle` | `playIntent && !mediaPaused` |

**反向约束同样重要**：意图为暂停时，`attemptPlay()` 不得自动续播（`:1016` 的 `if (!this.playIntent) return`）、`stalled` 不得复活快照 —— 用户按下的暂停必须被尊重。

### 3.4 乐观更新约定

`<video>` 的 `play`/`pause` 事件由浏览器**异步派发**：`video.pause()` 返回时事件尚未触发，此刻读 `video.paused` 已是 `true`，但快照仍为 `true`。若 UI 在命令返回后立即读快照（如播放按钮同步判断），会拿到过期值。

因此 `pause()` / 恢复型 `play()` / `seek()` / `setPlaybackRate()` 都**先同步纠正快照**，随后到达的 media 事件做幂等确认；`play()` 失败时回滚快照与意图。

### 3.5 会话指标的收口设计

`getSessionReport()` 的 5 个量（首帧耗时 / 卡顿次数 / 卡顿时长 / 实际播放时长 / 起播时刻）用**「已结算累计量 + 进行中时段起点」两段式**记录，读时实时补上进行中的一段（`:462-471`）：

```ts
stallDuration: this.stallAccum + (this.stallSince !== null ? now - this.stallSince : 0)
watchTime:    this.watchAccum + (this.watchSince !== null ? now - this.watchSince : 0)
```

好处是**不需要定时器**，也不会在暂停/卡顿时把时长算漏。

**最关键的一处设计是收口位置**：所有 `settle*` 调用集中在 `onStateChange` 的入口（`:1037-1044`），而不是只在 `RECOVERED` 事件里累加。原因——卡顿并不总以 `RECOVERED` 结束，期间可能迁到 `error`（重连）、`ended`（近尾判完）、或被用户 `pause`。漏掉任何一条，那段卡顿时长就永久少计，而且很难被发现。集中在状态变更入口结算后，**新增任何迁移路径都自动被覆盖**。

会话边界（写入 `types.ts:320-323` 的类型注释）：
- `play(PlayConfig)` 新一轮起播 → **重置**（`resetSession()`，且必须在 `transition('load')` **之前**，否则 `onStateChange` 会把旧会话的尾巴结算进新会话）；
- `switchURL()` → **不重置**（同一次观看行为换源，切开会让统计断裂）；
- `play()`（无参续播）→ **不重置**。

---

## 4. 内核层

### 4.1 `Kernel` 抽象与能力位

`Kernel` 接口（`types.ts:117-130`）有 8 个必需方法 + 3 个可选扩展（`getLevels` / `getCurrentLevel` / `setLiveLatency`，`NativeKernel` 不实现）。

`KernelCapabilities` 是**上层据此隐藏/降级入口的判据**，5 个位：

| 能力位 | HlsKernel | NativeKernel | 用途 |
|---|---|---|---|
| `lowLatency` | `true` | `false` | 能否配置 LL-HLS 目标延迟 |
| `qualitySwitch` | `true` | `false` | 能否手动切档（否则隐藏清晰度入口） |
| `abr` | `true` | `false` | ABR 可否观测/干预 |
| `stats` | 随 `observability` | `'basic'` | 指标深度 |
| `nativeFallback` | `false` | `true` | **是否原生回退内核** |

`nativeFallback` 是 spec §3.2 的能力位之外新增的一位，用途写在类型注释里：原生路径下 MSE 独占的能力（AirPlay 投屏 / PiP / 精细 ABR 干预）会**移交回浏览器**，由平台接管；MSE 接管 `<video>.src` 后系统投屏按钮会消失，属需主动规避的回归。接入方据此判断"投屏/画中画该走系统 UI 还是 SDK 控件层"。

### 4.2 选路策略（`Player.ts:763-775`）

内核选路 = `f(源格式, 平台能力, 观测档位)`：

```
config.kernel 显式指定  → 用它
observability === 'full'
    ├─ HlsKernel.isSupported() → HlsKernel
    └─ 否则 → NativeKernel（Safari <17.1 无 MSE，播放仍可用，仅深度观测降级）
observability === 'basic'
    ├─ 原生可播 HLS → NativeKernel
    ├─ 原生可播 MP4 → NativeKernel
    ├─ MSE + HlsKernel 可用 → HlsKernel
    └─ 都不行 → 抛错「平台不支持任何可用播放内核」
```

**观测档位是目的，内核选路是伴随结果**（spec §3.2 的明确表述）——这点容易读反。`basic` 档的语义是"只依赖 `<video>` 标准事件"，省电是副产品。

`observability` 为**静态配置**（初始化时确定，不支持热切换），因为换内核需销毁重建 hls.js/MMS 实例。

### 4.3 内核事件桥接

两个内核都通过 `KernelOptions.onEvent(event, data)` 回调上报，`Player.handleKernelEvent`（`:670-691`）统一处理：

```
所有内核事件  → 原样透传为 Events.KERNEL_EVENT（{ type, data }）
manifest_parsed → onManifestParsed()   // 清超时、探测服务端能力、更新档位、状态机迁移、attemptPlay
levels_updated  → updateQualities()
level_switched  → emit(Events.ABR_CHANGE)
error           → onKernelError()      // → isFatalKernelError + mapErrorCode → dispatchError
frag_loaded     → emit(Events.SPEED_UPDATE, speedInfo())
```

`HlsKernel` 只在 `observability === 'full'` 时监听 `FRAG_LOADED`（`:181-193`），下载速率用 0.7/0.3 的指数滑动平均。

### 4.4 资源回收（MSE 的坑集中在 HlsKernel）

MSE 路径下 `<video>.src` 是 `blob:` object URL，回收时机错一次就是泄漏。`HlsKernel` 里三处显式处理：

- **`switchURL()` 先释放旧源再挂新源**（`:51-54`）：hls.js 无"无缝换源"能力，`loadSource` 会触发新 manifest 解析；若上一源尚未 attach 完成（不在 `sourceopen` 态），直接 loadSource 会遗留旧 MediaSource 与其 object URL。
- **`destroy()` 先 `detachMedia()` 再 `destroy()`**（`:122-130`）：attachMedia 未走到 sourceopen 时被 destroy，旧 MediaSource 的 sourceopen 回调可能仍持有旧 video 引用。
- **`releaseMediaSourceUrl()` 兜底**（`:139-155`）：部分浏览器 destroy 后仍保留 blob src。

对应地，`Player.destroy()`（`:588-613`）的顺序有硬约束：**内核必须先于 `<video>` 移除销毁**，否则 hls.js 的清理回调会操作悬空节点。此外销毁前先退出全屏（否则部分浏览器把页面卡在全屏态）。

`NativeKernel.destroy()` 则需 `removeAttribute('src')` + `load()` 中止挂起的网络请求，否则反复 switchURL/destroy 会让旧请求 linger。

### 4.5 全屏的两条平台路径

这是实现层最容易只做一半的地方：

- **标准路径**：`el.requestFullscreen()`，状态经 `document.fullscreenchange` 同步。**注意 `requestFullscreen()` 返回 Promise，必须 `.catch()` 消费**，否则非用户手势/权限策略下被拒会抛 `unhandledrejection`。
- **iOS 原生视频全屏**：走 `webkitEnterFullscreen()`，状态标记在 `video.webkitDisplayingFullscreen`，**既不派发 `fullscreenchange`、也不体现在 `document.fullscreenElement`**。退出必须调 `video.webkitExitFullscreen()`，`document.exitFullscreen()` 对它无效。

因两条路径并行，`bindMediaEvents` 里同时监听 `document` 的 `fullscreenchange`/`webkitfullscreenchange` 与 video 的 `webkitbeginfullscreen`/`webkitendfullscreen`（`:768-775`），而 `MediaProxy.isFullscreen()` 额外认 `webkitDisplayingFullscreen`。**只判标准 API 会在 iOS 上恒为 false**，导致全屏态不同步、退出按钮无从触发。

---

## 5. 插件与钩子

### 5.1 生命周期与注册

`create` → `init` → `ready` → `destroy`（`BasePlugin`，49 行）。`PluginManager.add`（`:22-42`）要点：

- **构造器与实例皆可**：`typeof input === 'function'` 判断后 `new` 或直接用；
- **`ready()` 的补调**：注册时若 `player.kernelReady` 已为 true，立即补调一次——否则运行期动态注册的插件永远等不到 ready；
- **同名插件跳过并告警**，不抛错。

`ready()` 的触发点是 `emitFirstFrame()`（`:877-884`）——`FIRST_FRAME` 事件与 `plugins.readyAll()` 共用一个**一次性闸门** `firstFrameEmitted`。这个耦合有历史原因（它兼作"插件可以开始工作了"的就绪信号），但也是 v0.3.0 首帧耗时统计出错的根因，见 §8.3。

### 5.2 Preset

```ts
const PRESETS = {
  live: [ConsoleReporter, LivePolling],
  vod:  [ConsoleReporter],
}
```

Preset **只含功能插件，不含内核**（内核由 `config.kernel` 或 sniffer 选路）。`config.ignores: ['reporter', 'livePolling']` 按 `static pluginName` 裁剪。

### 5.3 Hooks：命令级 before/after 拦截

`Hooks`（31 行，`Map<string, HookFn[]>` + `use` / `run` / `destroy`）是 spec §3.6 描述的 before/after 拦截机制。它本身一直是完整的，问题在于**没有调用方**——`runHooks` 在 v0.3.0 及之前只被它自己的定义引用（`Player.ts:553` / `:562`），接入方 `useHooks('switchQuality', fn)` 注册成功、拿到解绑函数、**回调永不触发**。这类静默失效与死事件同源，成因见 §9.3。

**v0.4.0 的接线形态**：`Player` 内部通过两个私有收口方法调用钩子（`Player.ts:655` / `:668`）：

```ts
private async hookBefore(name, ctx): Promise<boolean>  // 返回 true = 被拦截，跳过内置逻辑
private async hookAfter(name, ctx, applied: boolean)   // applied = 内置逻辑是否真的生效
```

已接线的三个命令与 `ctx` 字段：

| 钩子名 | `ctx` 附加字段 | before 拦截点 | `applied=false` 的成因 |
|---|---|---|---|
| `'play'` | `input`（原始入参，可能 `undefined`） | 起播/恢复被拒绝 | 目前不产生（成功路径才触发 after） |
| `'switchQuality'` | `id` | 拒绝本次切档 | 内核无 `qualitySwitch` 能力；或 `id` 不在 `qualityMap` |
| `'switchURL'` | `url` | 拒绝本次换源 | 目前不产生（抛错路径不触发 after） |

**拦截协议**：`HookFn` 的返回类型是 `void | Promise<void>`，没有回传通道，因此决策统一走**写回可变 `ctx`** —— before 阶段置 `ctx.cancelled = true` 即跳过内置逻辑。`ctx.phase` 让同一个处理器能同时承担两个阶段。

**关键设计取舍（为什么 `switchQuality` 变成了 `Promise<void>`）**：before 钩子要支持"先异步查权限、再决定是否放行"，就必须 `await`；而原签名是同步 `void`。改签名为 `Promise<void>` 是一次**公开契约变更**，判断依据是代价不对称：`void → Promise<void>` 对既有调用方源码兼容（语句式调用 `player.switchQuality(1)` 照样合法，不 `await` 也不会报错），而不改则等于把"可拦截"降级成"只能事后通知"。`ui/controls.ts:118` 的调用点已同步改为显式 `void player.switchQuality(...)`，避免未处理的 Promise。

**边界（有意不做）**：`pause` / `mute` / `setVolume` 等轻量同步命令**没有**挂钩子——拦截价值低，而改成异步会让"按下即生效"退化成一个微任务延迟。

> **回归测试**：`test/events-liveness.test.ts` 覆盖 before 拦截、after 的 `applied` 三态（true / 内核不支持 / id 未知）、异步钩子被 await、以及 `play` 被拦截时**内核根本不被创建**。

---

## 6. 可观测与上报

### 6.1 三层数据出口

v0.3.0 之后，查询式数据被刻意分成三层，避免语义混杂：

| 出口 | 语义 | 字段 | 何时用 |
|---|---|---|---|
| `getStats()` | **此刻这一瞬间**的质量 | `bitrate/width/height/videoCodec/fps/speed/avgSpeed/droppedVideoFrames`（全 optional） | 码率面板、实时质量 |
| `getSessionReport()` | **本轮会话自起播以来**的累计量 | `firstFrameCost/stallCount/stallDuration/watchTime/loadStartTime` | 观看时长上报、卡顿率 |
| `PlayerState` | **低频语义** | 见 §2.2 | UI 渲染 |

**为什么累计量不并入 `getStats()`**：两者混在一起后，"尚未起播"与"值就是 0"在类型上无法区分（`StatsInfo` 字段全 optional），接入方只能靠猜；且未来给 `StatsInfo` 加字段时的兼容判断会变复杂。

`bufferInfo()` 另有**多口径**设计（`utils/buffer.ts:25-50`）：`remaining/length` 是当前播放点所在**连续区间**的剩余/总长，`totalRemaining/totalLength` 是**所有区间之和**。孤岛场景下二者会分歧——`buffers=[[0,10],[30,40]]`、`currentTime=5` 时，remaining=5 而 totalRemaining=15。只用单口径会误报"缓冲充足"。

### 6.2 错误分级与去重

`ERROR_CODE` 共 12 个值（`constants.ts:29-49`）。两条分级逻辑：

- **内核错误映射**（`utils/errors.ts:24-33`）：`details` **统一 `toUpperCase()` 后子串匹配** `MANIFEST` / `FRAG` / `NETWORK`；404 需配合 `httpStatus` 参数——hls.js 把状态码放在 `data.response.code`，details 恒为 `manifestLoadError`，仅凭 details 永远判不出 404。
- **`fatal` 判定**（`:91-96`）：同样忽略大小写，`MANIFEST`/`CODEC`/`KEY` 任一命中 + 内核标 fatal；另需 `type === 'mediaerror'`。

**10s 同类错误去重**（`utils/retry.ts:33-38`）是**有意设计，不是缺陷**：直播断流往往是同一故障的连续外化，内核会成串抛同类错误；逐条透出会让 Sentry 刷屏，且每条都触发一次重连——这正是"重试风暴"。表现是"连续两次同类错误只触发 1 次重试"，这是预期行为。调试连续重试链路应换用**不同类型**的错误构造。

### 6.3 诊断快照

`RetryDiagnostic`（`types.ts:440-457`，16 个字段）在每次错误/重连时采集，反映"决策当时"的真实环境：本次实际使用的地址（可能已切 backup）、主地址、是否走备用流、网络质量档、`navigator.onLine`、前后台、Network Information API 三字段、缓冲上下文、重试次数与退避延迟。

三处同时暴露：`PlayerError.diagnostic`、`Events.RETRY` 载荷、`ReportRecord.data.diagnostic`。另可用 `getLastRetryDiagnostic()` 直接读取最近一次。

### 6.4 上报通道

`dispatchReport`（`:1350-1359`）**遍历所有插件**，调用其 `report()` —— 不限于 Reporter 插件，任何实现了该方法的对象都会收到。多路上报即多装几个插件。SDK 负责"采什么、怎么分级/节流"，插件只负责"往哪发"。

`ConsoleReporter` 的 `pluginName` 是 `'reporter'`——这就是 `ignores: ['reporter']` 能关掉它的原因。

---

## 7. 稳定性机制

### 7.1 重连与退避

```
dispatchError → 10s 去重 → emit(ERROR) + dispatchReport
              └─ fatal? → 状态机 error，结束
              └─ 非 fatal → recover()
recover → 状态机 timeout/error → 检查 retryCount 上限
        → emit(RETRY) + 退避定时器 → reload()
reload  → 第 1 次重连切 backup，其后回主地址
        → 重算 usingBackup、同步 playing 快照
        → kernel.load(url)（异步，必须消费 reject）
```

退避公式（`utils/retry.ts:51-53`）：`base * 2^(n-1) + random() * base` —— 指数增长避免与服务端故障共振，`[0, base)` 抖动打散多端同时重连（惊群）。

`retryCount` / `retryDelay` / `loadTimeout` 都是 `NetworkTunable`，按**当前网络质量档**动态求值（见 §7.3）。

### 7.2 稳定性相关的竞态处理

实现里有四处显式竞态防护，值得注意：

| 机制 | 位置 | 防的是什么 |
|---|---|---|
| `playRequestId` 自增编号 | `:197` / `:232` | 连发起播时，旧请求解析完配置后不得覆盖新请求（`if (reqId !== this.playRequestId) return`） |
| `generation` 轮次代号 | `LivePolling:67` | `stop()` 后，在途请求返回时**自己把定时器续上**——表现为"已经停了却还在请求"，且再也停不掉 |
| `inFlight` | `LivePolling:60` | 上一轮未返回时又被 `start()` 拉起；**跳过本轮但仍排下一轮**，不能因一次跳过让轮询链断裂 |
| `firstFrameEmitted` 一次性闸门 | `:98` | 防止 `FIRST_FRAME` 与 `readyAll()` 重复触发 |
| `handlePlayRejection` | `:999-1011` | `AbortError`（换源/暂停打断，正常竞态）与 `NotAllowedError`（自动播放被拦截）从真实错误中分离；前者静默忽略，否则初始化期与重连期会大量误报 |

### 7.3 网络自适应

`NetworkConfig` 的 5 个参数支持 `number | ((q: NetworkQuality) => number)`。内置默认策略的方向是**网络越差越保守**：

| 参数 | good | fair | poor |
|---|---|---|---|
| `targetLatency` | 8s | 12s | 20s |
| `maxLatency` | 16s | 24s | 40s |
| `retryCount` | 2 | 4 | 8 |
| `retryDelay` | 500ms | 1500ms | 3000ms |
| `loadTimeout` | 8s | 12s | 20s |

`offline` 档不参与数值调整——断网走断流重连，而非降延迟/降超时。

求值时机两条路径：`EnvAdapter.onNetworkQualityChange` 回调（事件驱动）+ 起播/重连前主动 `getNetworkQuality()` 拉快照（不依赖回调时序）。

`latencyOverride` 的优先级设计：**覆盖项优先生效，未覆盖项回落到动态策略**（`:1212-1218`）——因此只覆盖 `target` 时，`max` 仍能随网络自适应。

### 7.4 媒体错误的分类映射

`mapMediaErrorCode`（`utils/errors.ts:56-80`）是 v0.3.0 新增的，背景见 §8.3。映射表：

| `MediaError.code` | 规范常量 | 映射 | fatal |
|---|---|---|---|
| 1 | `MEDIA_ERR_ABORTED` | **不上报**（返回 null） | — |
| 2 | `MEDIA_ERR_NETWORK` | `network_error` | false |
| 3 | `MEDIA_ERR_DECODE` | `media_decode_error` | **true** |
| 4 | `MEDIA_ERR_SRC_NOT_SUPPORTED` | 含网络痕迹 → `network_error`；否则 `media_src_not_supported` | 前者 false / 后者 true |
| 其他/缺失 | — | `network_error`（保持历史行为） | false |

两处判断值得留意：

- **code=1 不上报**：换源、destroy、用户操作导致的中止属正常竞态，上报即噪声。
- **code=4 需二次判定**：原生路径下"地址 404 / 服务不可达"与"容器格式不支持"**都表现为 `SRC_NOT_SUPPORTED`**，仅凭 code 无法区分——前者应走重连，后者应直接放弃。
- **code 缺失时保持可恢复语义**：部分 WebView / 极简 DOM 替身不给 `code`；此时若升级为 fatal，会中断原本有效的自动重连。

---

## 8. 变更档案（v0.1.0 → v0.4.0）

> 本节是本文的重点。四代变更对应四个提交：
> `51202c4` 首次发布（0.1.0）→ `3b567e8`（0.2.0）→ `ca34c46`（0.3.0）→ v0.4.0（事件活性 + Hooks 接线）。
>
> 归入"变更"的判据是：**该处代码在基线基础上被修改过，或新增能力的动机需要记录**。每项都给出"原来的形态 → 问题（机制层面）→ 现形态"，不写业务流程。

### 8.1 变更模式归纳（先看这个，再看细目）

把四代变更放在一起看，会发现它们高度同构，几乎全部落在三类上：

| 类型 | 含义 | 本项目的实例 |
|---|---|---|
| **A. 契约漏了** | 语义客观存在，但契约里没这个字段/命令，接入方只能自己造 | `sessionState`、`currentTime/duration`、进度、5 个控制命令 |
| **B. 接线接错了 / 压根没接** | 契约有、实现也有，但两者没接上或接错，**失败方式完全静默** | 错误码大小写（→ 全落 `UNKNOWN`）、`autoplay` 语义未生效、`stalled` 缺边、`reload` 异步 reject 未消费、**死事件 `PLAY`/`BUFFER_UPDATE`**、**`runHooks` 无调用方** |
| **C. 平台差异只做了一半** | 标准 API 路径做了，私有/回退路径没做，只在特定平台暴露 | iOS 原生全屏状态、MSE poster 呈现时机、MediaError 分类 |

**为什么这个归纳重要**：A 类是真缺口，需要补契约；B 类多数是**改动量极小但影响面极大**（如 `toUpperCase()` 一行），且因为"静默"而极难在测试中发现；C 类只在特定设备暴露，必须靠平台知识而非测试覆盖。三类对应的排查手法完全不同。

**B 类内部还有两个子形态，排查手段并不相同**（v0.4.0 之后补充的区分）：

| 子形态 | 特征 | 实例 | 怎么发现 |
|---|---|---|---|
| **B1 接错了** | 有调用点，但语义/参数不对 | 错误码大小写、404 取错字段、`autoplay` 未生效 | 顺着"调用点"读，能看到它确实被调了 —— **读代码有机会发现** |
| **B2 压根没接** | 契约声明完整、实现完整、**调用点数量为 0** | 死事件（零 `emit`）、`runHooks` 无调用方 | 顺着"实现"读**永远发现不了**（没有可顺的线索），必须**普查**：对契约的每个成员统计调用/派发点 |

B2 是最隐蔽的一类：读代码时注意力天然落在"存在的代码"上，不会落在"缺失的调用"上。0.4.0 那两项缺陷正是靠"对着 `Events` 枚举逐个统计 `emit` 数"才暴露的 —— 而这个动作现在是**自动化**的（`verify/events.mjs`，见 §10）。

### 8.2 v0.2.0：六项（提交 `3b567e8`）

这一代的共同背景：**在一个真实直播业务接入的过程中，SDK 的若干"看起来能用"的能力被实测证伪**。六项按性质分述。

#### ① 错误码映射：大写匹配 + 丢 HTTP 状态码（B 类，影响最大）

- **原形态**：`mapErrorCode` 用大写关键词（`MANIFEST`/`FRAG`/`NETWORK`）匹配内核 details；`isFatalKernelError` 同样。
- **问题**：hls.js 的 data.details 是**小写驼峰**（`manifestLoadError` / `fragLoadError` / `networkError`）。两个后果：全部错误落到 `ERROR_CODE.UNKNOWN`，接入方按错误码做的"接口与 CDN 异常"分类整体失效；`fatal` 判定恒为 false，**致命错误被误判为可恢复**，进而走无意义的重连。
  另外 404 无法识别：hls.js 把状态码放在 `data.response.code`，details 恒为 `manifestLoadError`。
- **现形态**：两处统一 `toUpperCase()`；`mapErrorCode` 增加第二参数 `httpStatus`，`Player.onKernelError` 从 `d.response?.code` 取值传入。
- **同类问题的推广**：这个缺陷揭示了一条通用规则——**跨实现的关键词匹配必须归一化大小写**，因为"自研内核用全大写常量、第三方库用 camelCase"是常态。

#### ② 封面图（poster）呈现时机不可控（C 类）

- **原形态**：`poster` 只映射到 `<video>.poster`（`MediaProxy.set poster`）。
- **问题**：MSE 路径下 hls.js 把 `<video>.src` 接管为 `blob:`，**原生 poster 的呈现时机不可靠**——部分浏览器在 `attachMedia` 后即清空封面，或缓冲期不保持显示。而"首帧前铺满容器、起播后隐藏"恰好是直播业务的硬需求（同时也是预告/重播态切换封面的载体）。
- **现形态**：新增 `PlayerConfig.posterMode: 'native' | 'overlay'`。overlay 模式在 root 内建 `<img class="live-sdk-poster">`（absolute / inset:0 / object-fit:cover / z-index:1，**低于控件层的 10**），首帧呈现时隐藏，二次起播由 `playing` 事件兜底隐藏。
- **顺带修**：`MediaProxy` 的 poster setter 原本是 `if (url) this.el.poster = url` —— 真值守卫导致**传空值无法移除既有封面**，运行期"换封面/清封面"场景失效。改为 `this.el.poster = url ?? ''`。

#### ③ 状态快照缺进度（A 类）

- **原形态**：`PlayerState` 只有 `playing/volume/muted/qualities/currentQuality/capabilities`，**不含任何时间字段**。
- **问题**：接入方要显示进度只能自己 `addEventListener('timeupdate')` 或读 `player.media`，等于绕开状态契约；而这恰恰是最常被渲染的字段之一。
- **现形态**：新增 `currentTime` / `duration`，用**整秒节流**写入（`timeupdate` 约 4Hz，直写会让订阅方高频重渲染）。`duration` 如实透传 `Infinity`（直播），仅把 `NaN`/`undefined` 归一为 0。类型注释里明确写了 `Infinity` 无法 JSON 序列化、上报前需判 `Number.isFinite`。

#### ④ `PlayConfig.autoplay` 语义未生效（B 类）

- **原形态**：`play()` 路径下，是否自动开始播放只由 `playIntent` 决定，而 `playIntent` 与 `PlayConfig.autoplay` **没有任何关联**；`autoplay` 仅在构造函数里配合 `config.url` 时被使用。
- **问题**：接入方传 `play({ url, autoplay: false })` 期望"只加载不播放"（典型场景：先展示封面，等用户手势），实际会直接开始播放——**参数被静默忽略**。同样的语义在两条路径下行为不一致，是最难排查的一类。
- **现形态**：`playIntent = cfg.autoplay !== false`（缺省视为 true，保持调用 `play()` 即播放意图的既有行为）。语义分工写进类型注释：`PlayerConfig.autoplay` 管"`createPlayer` 之后是否自动发起一次 `play()`"，`PlayConfig.autoplay` 管"这一次 `play()` 里要不要自动开始播放"。
- **新增关联能力**：`play()` 无参 + `hasLoaded` = 恢复播放（不重新拉流）——这是 `autoplay:false` 之后业务的自然续接动作。

#### ⑤ `registerPlugin` 只收构造函数（A 类）

- **原形态**：`registerPlugin(Ctor)`，内部 `new`。
- **问题**：与常见插件 API（收实例）不一致；且接入方若想预先构造并持有插件引用（如需在别处调用插件方法）就做不到。更糟的是**两种约定混淆时不会报错**：传实例进去会被 `new` 一个实例的实例——或直接抛类型不符的错误，取决于实现细节。
- **现形态**：`PluginInput = PluginConstructor | Plugin`，`PluginManager.add` 内 `typeof input === 'function'` 判别。类型注释里明确写了"两种形态都会走 `create(player)` → `init(config)`，业务不要自行预先 register，否则会重复初始化"。

#### ⑥ 无业务态扩展位（A 类）

- **原形态**：`PlayerState` 全是内核字段，业务想把自己的状态（直播间 id、是否被用户静音、运营态…）放进同一条订阅链路，只能**另建一个 store**——于是每次播放器状态变更与业务状态变更都会触发两路重渲染，且两者的一致性要自己维护。
- **现形态**：`setAppState(patch)` 写入 `app.*` 命名空间；非前缀键**忽略并告警**而非抛错（运行时兜底，防止无类型约束的 JS 调用方覆盖内核字段）。空 patch 不触发订阅。
- **附带的契约演进**：`LiveStatusPayload` 结构化（此前只派发状态字符串），`BufferInfo` 增加 `totalRemaining/totalLength` 多口径，新增 `SentryReporter` 官方插件。

### 8.3 v0.3.0：控制命令、会话指标与三处缺陷（提交 `ca34c46`）

#### ⑦ 原生 media error 一律映射为 `network_error`（C 类 → 直接影响可观测分流）

- **原形态**：`bindMediaEvents` 的 `error` 监听里硬编码
  `dispatchError(makeError(ERROR_CODE.NETWORK_ERROR, '媒体加载失败', false))`。
- **问题**：`MediaError.code` 是 HTML 规范里的**定值枚举（1–4）**，语义确定、可靠，但被完全忽略。两个后果：
  1. **解码失败被打进"接口与 CDN 异常"分类**——接入方按错误码做的三部分分流（解码 / 网络 / 交互）整体错位，排查方向直接跑偏；
  2. 对**不可能恢复**的解码问题发起无意义重连（`fatal: false` 会进入 `recover()`）。
- **现形态**：新增 `mapMediaErrorCode(code, message)`，按 §7.4 的表映射；`ERROR_CODE` 增加 `MEDIA_DECODE_ERROR` / `MEDIA_SRC_NOT_SUPPORTED` 两个值（均 fatal）。`code=1` 不上报，`code=4` 按 message 是否含网络痕迹二次判定。
- **兼容性**：`code` 缺失（部分 WebView / DOM 替身）时仍返回 `network_error` + 非 fatal，**不把偶发错误升级为 fatal 而中断自动重连**。

#### ⑧ 控制命令缺失（A 类）

- **原形态**：`PlayerCommands` 只有 7 个：`play/pause/mute/setVolume/switchQuality/switchURL/requestFullscreen`。
- **问题**：补出 5 个缺口，各自的背景不同：
  - **`exitFullscreen`**：有进无出。且**内置 `FullscreenButton` 只会 `requestFullscreen()`**——全屏后按钮再点无效，用户被困在全屏，只能靠系统 Esc/手势退出。
  - **`seek` / `setPlaybackRate`**：直播点播混合场景需要（重播态 = VOD）。语义边界明确写进 JSDoc：`seek` 在直播无限流下 noop；`setPlaybackRate` 直播主场景不建议（变速持续累积/消耗延迟、破坏边缘跟随）。
  - **`setPoster`**：运行期换封面（"重播态换封面""预告转直播换封面"）。
  - **`setLiveLatency`**：运行期覆盖 LL-HLS 目标延迟，且**可清除**（不传参即恢复配置驱动的动态值）——覆盖值单独存放（`latencyOverride`）而不污染 `PlayerConfig`。
- **顺带修的三处**（都属 C 类平台差异）：
  - **全屏状态此前根本收不到**：iOS 原生视频全屏不派发 `fullscreenchange`、不体现在 `document.fullscreenElement`，必须双路监听（见 §4.5）；
  - **`requestFullscreen()` 的 Promise 未消费**：非用户手势/权限策略下被拒会抛 `unhandledrejection`；
  - **`destroy()` 时未退出全屏**：部分浏览器会把页面卡在全屏态。

#### ⑨ 无会话级指标出口（A 类）

- **原形态**：`getStats()` 是唯一的指标出口，语义是"此刻这一瞬间"（码率/fps/丢帧）。
- **问题**：而**观看时长、卡顿次数、卡顿时长、秒开耗时**这些**累计量**（也是上报最需要的），SDK 内部其实全都经手（`sessionState` 的迁移、首帧事件、`stalled/recovered`），但**没有任何出口**。接入方只能各写一份"记时间戳 → 配对收口 → 维护计数器"的样板代码，而这类代码极易在配对边界上算错（漏掉某条结束路径就永久少计）。
- **现形态**：`PlayerState` 增加 `sessionState` / `usingBackup`；新增 `getSessionReport()` 承载 5 个累计量。**刻意不并入 `getStats()`**——理由见 §6.1 的三层出口。
- **顺带修的两处 B 类缺陷**：
  - **状态表缺 `stalled → pause` 边**：这条边是 `sessionState` 能自洽的**前提**，不是可选项（详见 §3.1）；
  - **首帧耗时与一次性闸门耦合**：原实现只有 `emitFirstFrame()`，它由 `firstFrameEmitted` 守卫、**二次起播不重置**（因为它兼作 `plugins.readyAll()` 的就绪信号）。于是"切档/换源后重新起播"这条路径上，`firstFrameCost` 永远停在 null。现拆成两个生命周期不同的方法：`markSessionFirstFrame()`（每次起播都记）与 `emitFirstFrame()`（一次性闸门）。

#### ⑩ `LivePolling` 静默失败（B 类）

- **原形态**：`tick()` 里空 `catch {}`；固定的 `setInterval`。
- **问题**：接入方无法区分两种截然不同的处境——
  | 处境 | 业务侧观感 |
  |---|---|
  | 轮询正常，服务端状态确实没变（预期） | "状态一直没变" |
  | 轮询已持续失败、实际已死（故障） | "状态一直没变" |
  
  二者观感完全相同，**后者会让人相信一个错误的事实**。另有三个相关缺陷：
  1. **缺 `res.ok` 校验**：`fetch` 对 4xx/5xx **不 reject**（只有网络层失败才 reject），所以最常见的"500 + JSON 错误体"形态**既不进 catch、又取不到状态字段**，比静默还静默；
  2. **`as string` 断言使去重失效**：断言只影响类型、不改运行时值。服务端下发 `{"status": 0}`（数字）时，与字符串 `lastStatus` 比较恒不等 → **每轮都判为"状态变化"并派发**，去重整体失效；
  3. **无并发保护**，无退避（注释声称退避，实现里没有）。
- **现形态**：四项修复
  - `res.ok` 校验 + **HTTP 200 但取不到状态字段也算失败**（否则走静默 return，接入方同样会误判）；
  - 状态值显式 `String().trim()` 归一；
  - 新增独立事件 `live_status_error` + `LiveStatusErrorPayload`，按连续失败次数节流（1 / 3 / 10 / 其后每满 30），判据抽成**静态纯函数** `shouldReportFailure(n)` 以便单测锚定边界；`logger.warn` 不节流（日志本就给人排查用）；
  - `setInterval` → `setTimeout` 串联 + 指数退避（上限 5 分钟，可配置），成功一次立即复位；`generation` 轮次代号 + `inFlight` 并发保护（见 §7.2）。
- **为什么不并入 `Events.ERROR`**：状态接口 500 不该被记成"直播播放失败"，否则接入方的 `err.fatal` 兜底分支、错误率统计、Sentry 捕获都会被污染。**故障归因不能被打歪**。同理，事件名不进 `Events` 枚举——轮询是 `preset:'live'` 的可选旁路能力，不接 `liveStatus` 的接入方永远收不到，也不该被迫关心。

#### ⑪ `reload()` 未消费内核异步拒绝（B 类，缺陷最隐蔽）

- **原形态**：
  ```ts
  try {
    this.kernel?.load(url)   // 返回 Promise，异步 reject
    this.startLoadTimeout()
  } catch (err) { ... }      // 只能拦同步抛错
  ```
- **问题**：`kernel.load()` 是异步的，reject 从未被消费 → **`unhandledrejection`**。三层后果：
  1. Node / SSR 环境下直接**终止进程**；
  2. 浏览器里落到 `window.onunhandledrejection`，接入方的全局错误监控会收到一条与播放无关的噪声；
  3. **这次重连失败不进 SDK 错误通道**——既不派发 `error` 也不续排重试，表现为"重连静默中断"。与 ⑩ 的 `LivePolling` 是**同一种病：在应当报错的地方什么都不做**。
- **现形态**：显式 `pending.catch(...)` 并引回 `dispatchError`，继续重试直至耗尽。
- **这是同类缺陷的第二处**（第一处是 `requestFullscreen()` 的 Promise 未消费）。二者如此相似，说明"**凡返回 Promise 的 API 都必须显式消费**"应作为一条编码规约——本次已顺手补了 `verify/smoke.mjs` 的 `process.on('unhandledRejection')` 护栏：把未处理拒绝计为一条 FAIL，而不是让它崩掉进程、吞掉后续所有断言的输出。

#### ⑫ `airplay` 特性对齐口径错误（B 类）

- **原形态**：`airplay` 的 `server` 侧置 `'unknown'`，却在 `matchFeature` 里为它开特例、直接判 `matched = true`。
- **问题**：`unknown` 的语义是"**尚未探测**"，不是"不适用"。把它用作"无服务端依赖"的占位，会让报告里留下无意义的未对齐态；而在匹配逻辑里绕过服务端判据，则是**两处地方表达同一个事实**，迟早不一致。
- **现形态**：`airplay` 的 `server` 恒为 `'supported'`（`probeServerFeatures` 与初始值两处同步改），`matchFeature` 不再有任何特例——统一口径"客户端可用 **且** 服务端可用"。
- **可迁移的经验**：**不要用一个既有枚举值表达它不表示的含义**；宁可多加一个值，也不要在判据里开特例。

### 8.4 文档层的两处修正

- README 事件表里曾列出 `Events.LIVE_STATUS` 与 `Events.STATE_CHANGE` —— **这两个枚举成员并不存在**（`live_status` 是插件派发的独立事件名，`state_change` 从未定义）。已修正。
- 上一代的两份调研文档（`LivePolling` 失败处理、会话指标出口）已核实落地，并按「本地决策记录」处理：**不随仓库与 npm 包分发**（`.gitignore` 的 `docs/proposal-*.md`），README 中指向它们的链接已移除。

### 8.5 v0.4.0：两项 B2 类缺陷 + 一道防回归闸门

这一代的触发点是**通读源码时的程序化普查**，而非业务反馈 —— 前三代都是"接入方实测发现问题"，这一代是"自己把契约逐条对了一遍，发现有两处从来没接上"。三项改动全部属 B2 类。

#### ⑫ `PLAY` 与 `BUFFER_UPDATE`：声明完整、零派发（B2 类，最隐蔽）

- **原形态**：两者都在 `Events` 枚举里，都从根导出、都进 `dist/*.d.ts`，`player.on(Events.PLAY, cb)` 注册成功并返回解绑函数 —— 但 `src/` 全量检索**零 `emit`**。
  - `PLAY` 缺得最没道理：`PAUSE` **有** DOM 事件源（`bindMediaEvents` 里的 `on('pause', …)`），`PLAY` 却没有对应的 `on('play', …)`。**不对称本身就是漏接的证据。**
  - `BUFFER_UPDATE` 的孪生兄弟 `SPEED_UPDATE` 实打实挂在 `frag_loaded` 上（`:799`），两者在枚举里紧邻、显然成对设计，只有前者悬空。
- **问题**：接入方订阅后**永不收到回调**。后果不是报错，而是"以为接好了"——低缓冲预警不触发、播放起止埋点永远缺一半。这类静默失效比抛错更难排查，且**所有既有质量门都拦不住**（成因见 §9.3）。
- **现形态**：
  - `PLAY` ← media `play` 事件（`on('play', () => this.onMediaPlay())`，handler 在 `:916-918`）。语义边界与 HTMLMediaElement 原生事件严格对齐：**`PLAY` = 播放请求已被接受（`paused` 转 false，尚未出画），`PLAYING` = 真正开始输出**。**刻意不做首帧前噪声抑制** —— `pause` 会被 MSE attach 的 AbortError 连带误报，`play` 不会，它每次都是真实意图。
  - `BUFFER_UPDATE` ← media `progress` + **档位跨越判定**（`checkBufferLevel()`，`:506-512`）。为什么不挂 `timeupdate`：水位只随 `timeupdate`/`progress` 变化（~4Hz），逐次派发等于给所有订阅方塞一条 4Hz 高频流，与"快照只放低频字段"的整体节流原则冲突；而完全不派发又逼着每个接入方自开 `setInterval` 轮询 `bufferInfo()`。折中是**离散化**：把当前块剩余可播时长映射到 `BUFFER_LEVEL_THRESHOLDS = [1,3,5,10,20]` 秒的 6 个档位（`level` 0~5），**只在跨越边界时派发**。低缓冲预警因此变成一次订阅即可。
- **两个设计取舍**（都不是随手定的）：
  1. **按 `remaining`（当前块）而非 `totalRemaining`（全量并集）分档** —— 判定"还能不能连续播下去"只取决于当前块。孤岛场景（`buffers=[[0,10],[30,40]]`、`currentTime=5`）下 buffer 里囤着 35s 而当前块只剩 5s，真正发生的是卡顿，按并集算会误报"充裕"。
  2. **载荷带全量 `BufferInfo` + `level`** —— 档位是**派发判据**，秒数是**判定依据**。按并集口径或延迟口径（`behind`）判定的接入方，也能只订阅这一个事件；需要自定义阈值的直接读原始秒数，`BUFFER_LEVEL_THRESHOLDS` 与 `bufferLevelOf()` 已导出。
- **节流状态的重置点**：`bufferLevel` 在 `resetSession()` 里一并清零（`:549`）。否则新会话的第一份 `bufferInfo` 若与上一轮同档，起播瞬间的低水位会被**静默吞掉**。

#### ⑬ Hooks：实现完整、无调用方（B2 类）

见 §5.3 的完整展开。要点：`Hooks` 类一直是完整可用的，缺的只是调用点；spec §3.6 举的唯一示例 `useHooks('switchQuality', …)` 恰好就是最典型的失效场景。
v0.4.0 给 `'play'` / `'switchQuality'` / `'switchURL'` 接上 before+after，拦截协议走**写回 `ctx.cancelled`**（`HookFn` 无返回值通道），并因此把 `switchQuality` 的签名从 `void` 改为 `Promise<void>` —— 取舍依据写在 §5.3。

#### ⑭ 新增 `verify/events.mjs`：把 B2 类静默失效转为构建失败

- **原形态**：`npm run verify` = 类型校验 + 导出检查 + 冒烟。三道门都**只验契约的"形状"，不验契约的"活性"**。
- **现形态**：新增第四道 —— **事件活性普查**。逐个统计 `Events` 枚举成员在 `src/` 中的实际 `emit` 派发点，**零派发即失败**；同时校验"派发点引用的 `Events.X` 是否真的存在"（防拼错、防枚举改名后留下悬空引用），并提供 `INTENTIONALLY_SILENT` 豁免表（要求写明理由，让豁免成为一次有意识的决定）。
- **它的能力边界（不要过度解读）**：证明**存在**派发点，这正是"死事件"的判据（零派发点必然是死的）；但**不证明派发点可达** —— `emit` 写在一个永远进不去的 `if` 分支里仍会被判 OK。可达性由单测/冒烟/E2E 覆盖，两者互补。
- **自测**：临时往枚举塞一个 `__SELFTEST_DEAD` 成员，脚本正确报 `DEAD` 并以退出码 1 失败；撤回后恢复全绿 —— 即它确实拦得住 0.3.0 那对死事件。
- **配套回归测试**：新增 `test/events-liveness.test.ts`（18 条），覆盖 `PLAY` 与 `PLAYING` 的时序关系、`PLAY`/`PAUSE` 成对性、`bufferLevelOf` 边界取值、档位跨越与不重复派发、新会话重置、孤岛场景口径、以及 Hooks 的拦截与 `applied` 三态。

---

## 9. 缺口、已处置项与遗留

> 本节同时承担两个作用：**记录当前仍存在的缺口**，以及**归档已修复项的原始形态** ——
> 后者是给"后来者想知道这里为什么长这样"用的。已处置项保留而不删除，因为原始形态往往比结论更有信息量。

### 9.1 ✅ 已处置（v0.4.0）：两个死事件 `PLAY` 与 `BUFFER_UPDATE`

**0.3.0 及之前的形态**：18 个 `Events` 成员中，这两个**声明完整但全仓库零 `emit`**。

| 事件 | 当时的分析 |
|---|---|
| `BUFFER_UPDATE` | 设计意图是**订阅式的缓冲水位推送**，与查询式的 `bufferInfo()` 互补。其孪生兄弟 `SPEED_UPDATE` 实打实挂在 `frag_loaded` 上，两者在枚举里紧邻，显然是成对设计。`SPEED_UPDATE` 有天然触发点（分片加载完成正是速率变化的时刻），`BUFFER_UPDATE` 没有同等自然的点——缓冲水位只随 `timeupdate`/`progress` 变化（~4Hz），与整秒节流的进度同步语义冲突。**缺它，每个接入方都只能自开 `setInterval` 轮询 `bufferInfo()`** |
| `PLAY` | 语义应为"开始播放请求"，但 `Player` 未监听 media 的 `play` 事件。**逐条核对 `bindMediaEvents()`（当时 `:721-763`）绑定的事件**：`loadedmetadata / loadeddata / canplay / timeupdate / durationchange / playing / pause / waiting / stalled / ended / volumechange / ratechange / error` —— 13 个，**没有 `play`**，也没有 `progress`。`PLAYING` 覆盖了"已在播放"，`PLAY` 实际无人使用 |

**为什么它比普通的"没实现"更值得记录**：接入方 `player.on(Events.PLAY, cb)` 会注册成功、拿到解绑函数、**永远收不到回调**。静默不生效比抛错更难排查。

**处置（v0.4.0）**：
- `PLAY` ← media `play` 事件（`Player.ts:916-918`）。设计论据是**对称性**：`PAUSE` 有 DOM 事件源而 `PLAY` 没有，本身就是漏接的证据。
- `BUFFER_UPDATE` ← media `progress` + **档位跨越判定**（`checkBufferLevel()`，`Player.ts:506-512`），阈值 `BUFFER_LEVEL_THRESHOLDS = [1,3,5,10,20]` 秒。两个取舍（按当前块而非并集分档、载荷带全量 `BufferInfo`）的完整理由见 §8.5 ⑫。
- 防回归：新增 `verify/events.mjs`（§10）。

### 9.2 ✅ 已处置（v0.4.0）：Hooks 机制未接线

**当时的形态**：`useHooks` / `runHooks` 有完整实现，但 `runHooks` 在 `src/` 内**没有任何调用方**（唯一引用是它自身的定义，当时 `Player.ts:553` / `:562`）。spec §3.6 给出的唯一示例就是 `player.useHooks('switchQuality', ...)` —— 而 `switchQuality`（当时 `:291-305`）从头到尾**没有一行 `runHooks` 调用**：它只做「查 `qualityMap` → 转内核索引 → 写快照 → emit `QUALITY_CHANGE`」。spec 举的那个例子恰好是最典型的失效场景。

**处置（v0.4.0）**：给 `'play'` / `'switchQuality'` / `'switchURL'` 接上 before+after（实现与取舍见 §5.3）。当时考虑过的另一条路是"从公开 API 移除，比保留更诚实" —— 最终选补接线，因为这三个命令恰好是拦截价值最高的三个，而移除会让 spec §3.6 与 L4「拦截内置交互」整层失去载体。

### 9.3 为什么现有质量门没拦住（B2 类缺陷的共性成因，**仍然成立**）

这两项都不是"没实现"，而是**"声明了、导出了、类型全对、注册也会成功、但永远不触发"**。它们的共同成因是：**项目里所有质量门检查的都是契约的"形状"，没有一道检查契约的"活性"。**（0.4.0 之前的状态如下表；其中第 5 行是本节被验证后新增的那道闸门。）

| 质量门 | 实际检查的内容 | 为什么漏掉 |
|---|---|---|
| `verify/contract.ts` | **类型层**：`player.useHooks('switchQuality', async (ctx) => void ctx)`（`:123`）、`player.on('first_frame', …)`（`:126`）能否编译通过 | 只证明"API 存在且签名正确"，不证明"调用会发生"。`useHooks` 那行恰恰**掩盖**了问题——它看起来像是在验证 Hooks 可用 |
| `verify/smoke.mjs` | 只订阅它关心的几个事件：`error`、`ended`、`live_status` / `live_status_error` | 断言是"选择性"的，没人断言 18 个事件"每个都至少派发一次" |
| E2E（`test/e2e`） | 真实浏览器驱动播放，断言画面/图标/状态 | 同理，只驱动它关心的路径 |
| 单测 | 模块隔离测试（`StateMachine` / `EventBus` / `retry` / `buffer` / `errors` …） | `EventBus.emit` 的单测验证"发出去能收到"，**不验证"有没有人发"** |
| **`verify/events.mjs`（0.4.0 新增）** | 逐成员统计 `emit` 派发点，零派发即失败 | ✅ 这道门就是为堵住上面四行的盲区而加的 |

**结论：`Events` 枚举的完整性在 0.4.0 之前没有任何自动化守护。** 这类缺陷只能靠"对着枚举逐个统计 `emit` 数"的**普查**手段发现 —— 读代码无效，因为注意力天然落在"存在的代码"上，不会落在"缺失的调用"上。这个动作现在自动化了（§8.5 ⑭ / §10）。

> **仍未覆盖的相邻盲区**（诚实标注，避免"加了闸门就万事大吉"的错觉）：
> 1. `verify/events.mjs` 只普查 `Events` 枚举。**`useHooks` 的钩子名是自由字符串**（`'play'` / `'switchQuality'` / …），拼错不会有任何提示、也不会被这道闸门拦住。这条靠 §5.3 的表格与单测覆盖。
> 2. 普查证明"存在派发点"，不证明"可达"（详见 §8.5 ⑭）。

### 9.4 文档引用漂移

源码中 21 处 `§x.y` 引用指向母仓库的 spec（`m-player/docs/live-sdk-spec.md`），未随独立仓库分发；`docs/vs-xgplayer.md:5` 的 `../../docs/live-sdk-spec.md` 相对路径在独立仓库中同样落空。另：本文档中的 `文件:行号` 锚点会随源码改动漂移，通读时若对不上，以**方法名/标识符**为准（行号只是导航便利）。

### 9.5 Non-Goals（有意不做，非缺陷）

沿用 spec §1.3，实现上也确实未提供：

- FLV / DASH 等其他流协议；
- **渐进式点播文件**（普通 `.mp4` 直连）——注意 `basic` 档的选路里有 `canPlayNativeMP4` 分支，那是内核对"原生可播源"的兜底，不代表 SDK 承诺点播文件支持；
- DRM（FairPlay / Widevine）；
- 弹幕、礼物、字幕、投屏控件等互动能力；
- 业务态固化逻辑（预告片、预约直播、倒计时）——地基能力（直播状态、事件、UI 插件挂载）已提供，接入方做"组合"。

> **边界提醒**：`'overlay'` 封面图层是**呈现层**能力，不代表 SDK 支持进度条/点播交互；`seek` / `setPlaybackRate` 命令的存在同样不改变"不做 VOD"的边界——它们服务于 **HLS 点播流（重播态）**，且语义边界已写进 JSDoc。
> 同理，`BUFFER_UPDATE` 是**观测**能力，不改变"不做自适应码率决策"的边界 —— 它只报告水位，不替接入方决定降档。

---

## 10. 验证体系

分层原则（spec §8.3）：**单测跑 `src` 逻辑，冒烟与 E2E 跑 `dist` 产物**。

| 层 | 位置 | 覆盖 |
|---|---|---|
| 单测 | `test/*.test.ts`（8 个文件，134 用例） | 状态机迁移、缓冲口径、退避策略、错误码映射（含 `MediaError` 全码）、`LivePolling` 节流判据边界、`player` 会话指标与 `setAppState`、**事件活性与 Hooks 接线（`events-liveness.test.ts`，18 条）** |
| 契约校验 | `verify/contract.ts` | 14 个场景的**编译期**锚定——导出面、命令/方法签名、事件常量值域、类型约束（v0.4.0 补场景 14：`BUFFER_UPDATE` 载荷、`bufferLevelOf` 单调性、`switchQuality` 的 Promise 签名、钩子 ctx 字段） |
| 导出面校验 | `verify/exports.mjs` | 运行时检查 `dist` 实际导出的符号与 `Events` 值域 |
| **事件活性普查** | **`verify/events.mjs`（v0.4.0 新增）** | **逐个统计 `Events` 成员的 `emit` 派发点，零派发即失败**；并校验派发点引用的 `Events.X` 是否真实存在。当前结果：18/18 有派发点 |
| 冒烟 | `verify/smoke.mjs` | 运行时断言，跑 `dist` 产物；含 `unhandledRejection` 护栏 |
| E2E | `test/e2e/` | Playwright（chromium + webkit）；通过 `player.getKernel()` 注入"场务指令"驱动内核异常分支 |

### 10.1 两道"编译期证明"

`verify/contract.ts` 里有两处把**类型系统的报错反过来当断言用**的技巧，都靠 TS2367（"无意的比较"）：

1. `LIVE_STATUS_ERROR_EVENT !== Events.ERROR` —— 两个字面量类型无交集 → tsc 报错 → 该报错恰好是"两条错误通道互不干扰"的**编译期证明**。
2. `Player.hookBefore()` 里写回 `ctx.cancelled = false` 之后再判 `ctx.cancelled === true`，同样报 TS2367 —— 这反向证明了**编译器把该属性窄化成了字面量 `false`**，即它知道"代码本身没改它"；钩子在运行时能改，编译器看不到。判定前必须先放宽为 `unknown`（`Player.ts:657-661` 有注释说明）。这是本文件里唯一一处"必须绕过类型窄化"的地方，值得留意。

### 10.2 普查式断言的能力边界

`verify/events.mjs` 证明的是**存在**派发点（这正是"死事件"的判据），**不证明可达** —— `emit` 写在永远进不去的分支里仍会判 OK。可达性由单测/冒烟/E2E 覆盖。两者互补，不可互相替代；把它当成"事件一定可用"的证据是**过度解读**。

---

## 附：建议通读顺序

若目标是完整掌握实现，按依赖顺序读比按文件大小读高效：

1. `types.ts` → `constants.ts` — 契约先立，后面全是它的实现（**这两个文件里的注释本身就是设计说明**）
2. `core/StateMachine.ts`（69 行）→ `core/StateStore.ts`（37 行）— 两个纯逻辑件，无依赖
3. `core/Player.ts` 的**命令契约段**（`:207-423`）— 12 个命令，读的时候对照 §2.1 的语义边界；**注意每个命令前后的 `hookBefore` / `hookAfter`**（§5.3）
4. `core/Player.ts` 的**状态机副作用段**（`:1125-1199`）— `playing` / `sessionState` / 会话指标三者的收口点，是全文最需要精读的 70 行
5. `core/Player.ts` 的**错误分级与恢复段**（`:1200-1331`）— 重连、去重、诊断快照
6. `kernel/HlsKernel.ts` — 注意资源回收的四处显式处理（§4.4）
7. `plugins/LivePolling.ts` — 一个"旁路能力"如何做到既不打扰主链路、又不静默失败
8. `utils/errors.ts` + `utils/retry.ts` — 两个纯函数模块，边界条件全在这里

`Player.ts` 从 `:728` 起是**内部机制段**（配置解析 / 内核选路 / media 事件绑定 / 进度同步 / 错误恢复 / 网络自适应 / env 适配 …），可按需查阅，不必顺序读。其中 `:832-894` 的 `bindMediaEvents()` 值得单独看一眼：**18 个事件的 DOM 源头几乎都在这里**，`PLAY` 与 `BUFFER_UPDATE` 的接线就是在这张表里加两行。

---

## 附二：这次通读"应该带走什么"

如果只有 5 分钟，读这三条：

1. **契约的"形状"和"活性"是两件事。** 本项目最隐蔽的两类缺陷（死事件、Hooks 无调用方）都不是"没实现"，而是"实现了但没接上"；类型系统、冒烟、E2E、单测**全都拦不住**。判据只有一个：**数调用点**（`verify/events.mjs`）。
2. **B2 类缺陷只能靠普查发现。** 顺着实现读永远发现不了"缺失的调用" —— 因为注意力天然落在存在的代码上。这也是为什么这次是"对着枚举逐个统计 `emit` 数"而不是"再读一遍代码"。
3. **有意识的补充 vs 静默的悬置。** `BUFFER_UPDATE` 挂 `progress` 做档位跨越、`PLAY` 与 `PAUSE` 对称、Hooks 用写回 `ctx` 表达拦截 —— 这些选择都有明确理由，写在了代码注释与本档的 §8.5；而"声明了但不确定什么时候触发"（0.3.0 的两个死事件）是最差状态：它不会报错，只会让接入方**以为接好了**。
