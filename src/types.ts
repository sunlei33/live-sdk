/**
 * live-sdk 全部共享类型定义。
 * 与 docs/live-sdk-spec.md 的 API 面逐字对齐，是「内核 / 插件 / 接入方」三方契约的唯一来源。
 */
// `SessionState` 的声明在 constants.ts（状态机与常量同处一地），此处仅做类型引用。
// 纯类型导入在编译期被完全擦除，不会与 constants.ts 形成运行时循环依赖。
import type { SessionState } from './constants'

// ───────────────────────────── 观测档位 ─────────────────────────────

/** 观测深度：full=深度采集（分片/缓冲/码率/ABR/速率），basic=仅 <video> 标准事件 */
export type Observability = 'full' | 'basic'

// ───────────────────────────── 内核抽象 ─────────────────────────────

/** 内核能力位（用于上层据此隐藏/降级入口） */
export interface KernelCapabilities {
  lowLatency: boolean // 是否可配置 LL-HLS（targetLatency 等）
  qualitySwitch: boolean // 是否可手动清晰度切换
  abr: boolean // ABR 是否可观测/可干预
  stats: 'full' | 'basic' // 指标深度
  /**
   * 是否为原生回退内核（NativeKernel）。
   * 用途：原生路径下 MSE 独占的能力（AirPlay 投屏 / PiP / 精细 ABR 干预）会**移交回浏览器**，
   * 由平台原生接管，SDK 侧不承诺（MSE 接管 `<video>.src` 后系统投屏按钮会消失，需主动规避）。
   * 接入方据此判断：native=true 时投屏/画中画走系统 UI，不要依赖 SDK 的控件层。
   */
  nativeFallback: boolean
}

/** 实时指标（对应 getStats） */
export interface StatsInfo {
  bitrate?: number
  width?: number
  height?: number
  videoCodec?: string
  fps?: number
  speed?: number // 瞬时下载速率（bit/s）
  avgSpeed?: number // 平均下载速率（bit/s）
  droppedVideoFrames?: number
}

/**
 * 缓冲区间（对应 bufferInfo）。
 *
 * ⚠️ 多口径说明（buffer 出现孤岛时，单口径会误导预加载/健康判断）：
 * - `buffers`：**全部**缓冲区间的原始并集（可能有多块，含 discontinuity 造成的孤岛）。
 * - `remaining` / `length`：**当前播放点所在**那一块连续区间的剩余/总长（沿播放方向最相关）。
 * - `totalRemaining` / `totalLength`：**所有**区间之和（跨孤岛的总囤积量，用于「是否已缓冲足够」判断）。
 * 例：buffers=[[0,10],[30,40]]、currentTime=5 → remaining=5（当前块到 10），
 *     totalRemaining=15（到 10 与到 40 的和），二者差异即为孤岛造成的口径分歧。
 */
export interface BufferInfo {
  buffers: [number, number][] // 全部缓冲区间（原始并集）
  behind: number // 落后 live edge 时长（s）
  remaining: number // 当前播放点所在连续区间的剩余时长（s）
  length: number // 当前播放点所在连续区间的总长（s）
  totalRemaining: number // 所有区间剩余时长之和（跨孤岛，s）
  totalLength: number // 所有区间总长之和（s）
}

/**
 * `BUFFER_UPDATE` 事件的载荷：`BufferInfo` 全量口径 + 派生档位。
 *
 * 为什么同时给「原始秒数」和「档位」：档位是**派发判据**（只有跨越档位边界才派发），
 * 秒数是**判定依据**（接入方可按自己的阈值再判一次）。两者都在，订阅方不必二选一。
 */
export interface BufferUpdatePayload extends BufferInfo {
  /** 缓冲水位档位（0 最紧张，5 最充裕）；边界见 `BUFFER_LEVEL_THRESHOLDS` */
  level: number
}

/**
 * 命令钩子的执行阶段（`useHooks(name, fn)` 的 `ctx.phase`）。
 * - `'before'`：内置逻辑执行**前** —— 写回 `ctx.cancelled = true` 可阻止本次操作
 * - `'after'` ：内置逻辑执行**后** —— 此时 `ctx.applied` 表明内置逻辑是否真的做了事
 */
export type HookPhase = 'before' | 'after'

/**
 * 命令钩子的上下文对象（`useHooks(name, fn)` 的回调入参）。
 *
 * **为什么是可变对象**：`HookFn` 的返回值被声明为 `void | Promise<void>`，没有回传通道，
 * 因此「拦截」只能靠钩子**写回 ctx**表达 —— `ctx.cancelled = true` 即告知内置逻辑跳过。
 * 这也让同一个处理器可以按 `ctx.phase` 同时承担 before / after 两个阶段。
 *
 * 各命令在 ctx 上附加的字段：
 * | 钩子名 | 额外字段 |
 * |---|---|
 * | `'play'` | `input`：`play()` 的原始入参（可能为 `undefined`） |
 * | `'switchQuality'` | `id`：请求的 `Quality.id`（`-1` = 自动） |
 * | `'switchURL'` | `url`：目标地址 |
 */
export interface CommandHookContext extends Record<string, unknown> {
  /** 当前阶段。同一个钩子名会被调用两次，用本字段区分 */
  phase: HookPhase
  /** **仅 `'before'` 阶段可写**：置 `true` 则跳过内置逻辑 */
  cancelled: boolean
  /** **仅 `'after'` 阶段**：内置逻辑是否真的生效（`false` = 判定为 no-op） */
  applied?: boolean
}

/** 下载速率（对应 speedInfo） */
export interface SpeedInfo {
  speed: number
  avgSpeed: number
}

/** 清晰度档位信息（从 master m3u8 解析，用于 Quality.id 映射） */
export interface LevelInfo {
  index: number
  height: number
  bitrate: number
}

/** 内核统一抽象：屏蔽 hls.js 与原生回退的差异 */
export interface Kernel {
  readonly capabilities: KernelCapabilities
  load(url: string): Promise<void>
  switchURL(url: string, startTime?: number): Promise<void>
  switchQuality(levelIndex: number): void // 切到 hls.js level 索引（-1=自动）；qualitySwitch=false 时不应调用
  getStats(): StatsInfo // stats=basic 时返回受限集
  bufferInfo(): BufferInfo
  recover(): void
  destroy(): void
  // —— 扩展方法（NativeKernel 不实现）——
  getLevels?(): LevelInfo[] // 清晰度档位列表
  getCurrentLevel?(): number // 当前档位索引（-1=自动）
  setLiveLatency?(target: number, max: number): void // LL-HLS 运行时更新目标延迟
}

/** 内核构造器（createPlayer 的 kernel 参数 / sniffer 自动选路产物） */
export interface KernelConstructor {
  new (opts: KernelOptions): Kernel
  isSupported(): boolean
  readonly kernelName: string
}

/** 内核构造入参 */
export interface KernelOptions {
  media: HTMLVideoElement
  hlsConfig?: Record<string, unknown>
  observability: Observability
  onEvent: (event: string, data?: unknown) => void
}

// ───────────────────────────── 宿主环境适配 ─────────────────────────────

export type NetworkQuality = 'good' | 'fair' | 'poor' | 'offline'
export type VisibilityState = 'foreground' | 'background'

export interface EnvAdapter {
  getVisibility(): VisibilityState
  onVisibilityChange(cb: (v: VisibilityState) => void): () => void
  isOnline(): boolean
  onNetworkChange(cb: (online: boolean) => void): () => void
  getNetworkQuality?(): NetworkQuality
  onNetworkQualityChange?(cb: (q: NetworkQuality) => void): () => void
}

// ───────────────────────────── 起播输入 ─────────────────────────────

export interface Quality {
  id: number // 业务自定义稳定标识，switchQuality 入参；与 master m3u8 解耦
  label?: string // 显示名（如「蓝光 1080P」）
  height?: number // 主映射键：分辨率高度（对应 RESOLUTION）
  bitrate?: number // 兜底映射键 / 展示参考码率（对应 BANDWIDTH）
}

export interface PlayConfig {
  url: string // 主播放地址
  backup?: string // 备用流
  liveStatus?: string // 直播状态查询接口
  /**
   * 本次起播是否**自动开始播放**。缺省 `true`（调用 play() 即播放意图）。
   *
   * 显式传 `false` = 「只加载、不自动播放」：manifest 就绪后不调用 `<video>.play()`，
   * `PlayerState.playing` 保持 false、按钮呈「播放」态，等用户手势后再由业务调用
   * `player.play()`（无参）开始播放。典型场景：先展示封面图。
   *
   * 与 `PlayerConfig.autoplay` 的区别：后者管「createPlayer 之后是否自动发起一次 play()」，
   * 本字段管「这一次 play() 里要不要自动开始播放」。
   */
  autoplay?: boolean
  muted?: boolean // 静音
  poster?: string // 封面图（呈现方式见 PlayerConfig.posterMode）
  quality?: Quality[] // 清晰度档位元数据（业务下发）
}

export type PlayConfigProvider = () => PlayConfig | Promise<PlayConfig>
export type PlayInput = string | PlayConfig | PlayConfigProvider

/**
 * 封面图（poster）呈现方式：
 *
 * - `native`（默认）：写 `<video>.poster`，由浏览器原生呈现。
 * - `overlay`：在视频之上叠一层绝对定位的 `<img>`，**首帧呈现后隐藏**。
 *
 * 为什么需要 `overlay`：MSE 路径下 hls.js 会把 `<video>.src` 接管为 `blob:`，
 * 原生 `poster` 的呈现时机不可靠（部分浏览器在 `attachMedia` 后即清空封面，
 * 或在缓冲期不保持显示）。用 DOM 图层叠一层可完全掌控显隐时机，且不受 MSE 影响。
 * 该图层 z-index 低于默认控件层，不会遮挡操作。
 */
export type PosterMode = 'native' | 'overlay'

// ───────────────────────────── 三契约（命令 / 状态 / 事件） ─────────────────────────────

export interface PlayerCommands {
  play(config?: PlayInput): Promise<void>
  pause(): void
  mute(m: boolean): void
  setVolume(v: number): void
  /**
   * 切换清晰度（入参 = `Quality.id`，`-1` 表示恢复自动 ABR）。
   *
   * 返回 `Promise<void>` 而非 `void`：内置逻辑前会 `await` 挂载在 `'switchQuality'`
   * 上的 before 钩子（spec §3.6），以便接入方异步拦截本次切换（如先查权限）。
   * 不关心钩子的调用方照旧 `player.switchQuality(1)` 语句式调用即可，无需 `await`。
   */
  switchQuality(id: number): Promise<void>
  switchURL(url: string): Promise<void>
  /**
   * 请求全屏（TODO-9）。
   *
   * @param target 期望全屏的元素。缺省 = `<video>`（历史行为，兼容不变）。
   *
   * 传容器元素（如 `player.root`，或业务自己的外层容器）做**容器级全屏** ——
   * 自绘控件与默认 UI 控件栏都挂在容器内，容器全屏后仍可见可点；
   * 只全屏 `<video>` 会让它们消失（`<video>` 不能有子元素，兄弟节点不在全屏范围内）。
   *
   * iOS Safari 不支持普通元素全屏时自动回退原生视频全屏；无全屏能力的环境静默降级。
   * 两种目标下 `PlayerState.fullscreen` 都会正确同步。
   */
  requestFullscreen(target?: Element): void
  /** 退出全屏（与 `requestFullscreen` 配对；iOS 原生视频全屏亦可退出） */
  exitFullscreen(): void
  /**
   * 定位到指定时间（秒），入参自动钳制到 `[0, duration]`。
   *
   * **仅对有限时长（HLS 点播 / `#EXT-X-ENDLIST` / 重播回放）生效**：
   * 直播无限流下为 noop —— 直播时间轴受 live edge 约束，任意定位会持续累积延迟，
   * 破坏「边缘跟随」语义（见 README「Non-Goals」）。若需在直播中回到实时边缘，
   * 请改用 `switchURL()` 重拉或等待流结束进入点播态。
   */
  seek(time: number): void
  /**
   * 设置倍速。**语义边界**：直播（无限流）下变速会持续累积/消耗延迟 ——
   * 调慢离边缘越来越远、调快在缓冲耗尽时反复走 `stalled`，故直播主场景不建议使用；
   * 点播/重播回放（有限时长）为正常用法。
   *
   * 入参经浏览器钳制后被**读回**写入 `PlayerState.playbackRate`（快照反映真实生效值）。
   */
  setPlaybackRate(rate: number): void
  /**
   * 运行时更换封面图（传 `undefined`/空串即移除）。
   * 呈现方式仍由 `PlayerConfig.posterMode` 决定（native 写 `<video>.poster`；
   * overlay 更新叠加图层）。典型场景：「重播态换封面」「预告转直播换封面」。
   */
  setPoster(poster?: string): void
  /**
   * 运行时覆盖 LL-HLS 目标延迟（秒），缺省参数回落到 `PlayerConfig.network` 的
   * `targetLatency` / `maxLatency`（含按网络质量动态求值的策略）。
   * 传空（不传参）表示**清除本次覆盖**、恢复配置驱动的动态值。
   * 内核不支持 `setLiveLatency` 时静默忽略（见 `KernelCapabilities.lowLatency`）。
   */
  setLiveLatency(target?: number, max?: number): void
}

export interface PlayerState {
  playing: boolean
  volume: number
  muted: boolean
  qualities: Quality[] // 有效档位列表（PlayConfig.quality 中已映射到 streams 的部分）
  currentQuality: number | null // 当前档位（Quality.id）；未切档/无档时为 null
  capabilities: KernelCapabilities
  /**
   * 会话真相：播放器内部此刻处于哪个阶段
   * （`idle` / `loading` / `ready` / `playing` / `paused` / `stalled` / `error` / `ended`）。
   *
   * ⚠️ **必须与 `playing` 分清，二者在卡顿时会分叉**：
   * - `playing` 回答「用户看到的是播放还是暂停」——**呈现语义**；
   * - `sessionState` 回答「播放器内部此刻处于什么阶段」——**事实语义**。
   *
   * 卡顿（`stalled`）期间 `playing` 仍为 `true`（已起播、只是缓冲，按钮该显示「播放中」），
   * 而 `sessionState` 为 `'stalled'`。因此：
   * - 播放/暂停**按钮形态** → 判 `playing`；
   * - 转圈提示、降级提示、埋点分类、「是正常播放还是卡住了」→ 判 `sessionState`。
   */
  sessionState: SessionState
  /**
   * 当前播放的是否为 `PlayConfig.backup` 备用流。
   *
   * 复位点（三处，缺一都会让标记与事实不符）：
   * - `play()` 新一轮起播 → `false`（起播恒用主地址）；
   * - `switchURL()` 显式换源 → `false`（业务主动指定的地址，不该继续显示「备用流中」）；
   * - 断流重连切到 `backup`（`reload()` 第 1 次）→ `true`。
   */
  usingBackup: boolean
  /**
   * 当前播放位置（秒）。**按「整秒变化」节流更新**（非 `timeupdate` 的 ~4Hz）——
   * 快照定位是低频字段，避免订阅方（如 React 组件）被高频重渲染。
   * 需要逐帧精度请直接读 `player.media.currentTime`。
   */
  currentTime: number
  /**
   * 媒体总时长（秒）。**直播为 `Infinity`**，HLS 点播（`#EXT-X-ENDLIST`）为有限值；
   * 元数据未就绪时为 `0`。注意 `Infinity` 无法 JSON 序列化（会变 null），
   * 上报前请自行判 `Number.isFinite`。
   */
  duration: number
  /**
   * 是否处于全屏。覆盖三种来源：
   * - 标准 Fullscreen API（`document.fullscreenElement`）；
   * - **容器级全屏**：全屏的是 `<video>` 的祖先（业务的容器 / SDK 的 `root`）；
   * - iOS 原生视频全屏（`webkitDisplayingFullscreen`，不出现在 `fullscreenElement` 里）。
   *
   * 用途：切换「进入/退出全屏」按钮形态，或在全屏变化时调整自绘控件布局。
   *
   * 注意：接入方若把更外层（如整个应用外壳）全屏，本字段也会为 `true`——此时视频确实占满屏幕，
   * 认定为全屏并允许一键退出，符合用户预期。
   */
  fullscreen: boolean
  /** 当前倍速（真实生效值，经浏览器钳制后读回）。默认 `1`。 */
  playbackRate: number
  [ext: `app.${string}`]: unknown // 扩展点：插件/业务命名空间，内核不预设
}

/**
 * 会话级累计指标（对应 `getSessionReport()`）。
 *
 * **为什么不并入 `getStats()`**：`StatsInfo` 的字段语义是「当前这一瞬间的播放质量」
 * （码率 / fps / 丢帧），而本接口的字段是「本轮会话自起播以来的累计量」。
 * 两类混在一起后，「尚未起播」与「值就是 0」在类型上无法区分，接入方只能靠猜；
 * 且未来给 `StatsInfo` 加字段时的兼容性判断也会变复杂。
 * 因此保持 `getStats()` 的瞬时语义不动，累计量单列一处 —— 三层各归其位：
 * 瞬时（`getStats`）/ 累计（`getSessionReport`）/ 低频语义（`PlayerState`）。
 *
 * **会话边界**：由 `play(PlayConfig)` 的**新一轮起播**重置（首帧耗时、卡顿次数与时长、
 * 实际播放时长全部清零，`loadStartTime` 取新的起播时刻）。
 * `switchURL()` **不重置** —— 那是同一次观看行为换源，不该把统计切成两段。
 * `play()`（无参，恢复播放）**不重置** —— 那是暂停后的续播，不是新一轮会话。
 */
export interface SessionReport {
  /**
   * 首帧耗时（ms）：从本轮起播请求（`play()`）到首个可呈现帧就绪（`loadeddata` / `canplay`）。
   * 尚未出首帧（或从未起播）为 `null`。
   *
   * 注意 `autoplay: false` 的场景：此时首帧信号可能要等到用户手势后才到，
   * 本值会把「等用户点播放」的时间一并计入。若你要的是「纯加载耗时」，
   * 请在 `autoplay: true` 下取用，或改用 `LOAD_START` → `FIRST_FRAME` 两个事件自行计算。
   */
  firstFrameCost: number | null
  /** 本轮会话累计卡顿次数（进入 `sessionState === 'stalled'` 的次数）。 */
  stallCount: number
  /** 本轮会话累计卡顿时长（ms）。进行中的卡顿按「此刻 − 进入时刻」实时计入。 */
  stallDuration: number
  /**
   * 本轮会话累计**实际播放**时长（ms）。
   *
   * 语义写死为「只累计 `sessionState === 'playing'` 的时长」——
   * 加载、暂停、卡顿、缓冲、后台冻结期间都**不计入**。观看时长上报要的就是这个口径。
   * 若你需要的是「会话挂钟时长」（含暂停与卡顿的总时长），
   * 请用 `Date.now() - loadStartTime` 自行计算，不要复用 `watchTime` 承载两种解读。
   */
  watchTime: number
  /** 本轮会话起播时刻（`Date.now()`）；从未起播为 `null`。 */
  loadStartTime: number | null
}

// ───────────────────────────── 网络敏感策略参数 ─────────────────────────────

/** 静态值，或按「最近一次网络质量」动态求值 */
export type NetworkTunable = number | ((q: NetworkQuality) => number)

export interface NetworkConfig {
  targetLatency: NetworkTunable // 目标延迟（s）
  maxLatency: NetworkTunable // 最大延迟（s）
  retryCount: NetworkTunable // 重连次数
  retryDelay: NetworkTunable // 重连退避基数（ms）
  loadTimeout: NetworkTunable // 请求超时（ms）
}

// ───────────────────────────── 端到端能力对齐 ─────────────────────────────

export type FeatureKey = 'lowLatency' | 'abr' | 'qualitySwitch' | 'drm' | 'airplay'
export type SideState = 'supported' | 'absent' | 'degraded' | 'unknown'

export interface FeatureStatus {
  feature: FeatureKey
  client: SideState // SDK + 平台侧能力（取最弱）；degraded=平台接管仍可用
  server: SideState // 服务端实际提供（manifest 探测）；无服务端依赖者（airplay）恒 supported
  matched: boolean // 端到端是否对齐可用（client 可用 且 server 可用）
  detail?: string // 差异说明
}

export interface FeatureStatusReport {
  features: FeatureStatus[]
  summary: { matched: number; mismatched: number }
}

// ───────────────────────────── 业务态扩展 ─────────────────────────────

/**
 * `live_status` 事件的结构化 payload（LivePolling 插件派发，§4.6）。
 * 仅在状态值**发生变化**时派发（低频、幂等）。
 *
 * 接入方可直接消费 `status` 做 UI 分支，也可从 `raw` 取业务自定义字段
 * （主播信息、预计恢复时间、运营文案等）——SDK 不解析、原样透传。
 */
export interface LiveStatusPayload {
  status: string // 归一后的状态值（取服务端 status / liveStatus / state 之一）
  previousStatus: string // 上一次状态；首次派发为空串
  raw: Record<string, unknown> // 服务端原始响应，原样透传
  time: number // 事件时刻（Date.now()）
}

/**
 * `live_status_error` 事件的结构化 payload（LivePolling 插件派发）。
 *
 * **为什么是独立事件，而不并入 `Events.ERROR`**：轮询失败是**旁路能力的故障**，
 * 不是播放错误。若并入后者，接入方按 `err.fatal` 分流的兜底逻辑、错误率统计、
 * Sentry 捕获都会把「状态接口 500」记成「直播播放失败」——
 * 故障归因被打歪，且一条接口抖动会污染整条播放错误链路。
 *
 * **事件名为什么不在 `Events` 枚举里**：与 `live_status` 同理 —— 轮询是
 * `preset: 'live'` 的可选旁路能力，不是播放内核契约的一部分。
 * 不接 `PlayConfig.liveStatus` 的接入方永远收不到它，也不该被迫关心。
 *
 * **派发节流**：`failCount` 在连续失败期间自增、一旦成功立即归零。
 * 为同时满足「首次失败要立刻知道」与「长时间断网不许刷屏」，只在
 * `failCount` 为 1、3、10 以及其后每满 30 次（30、60、90…）时派发事件；
 * `live_status_error` 之外每一次失败仍会走 `logger.warn`，日志不节流。
 */
export interface LiveStatusErrorPayload {
  url: string // 轮询接口地址
  failCount: number // 连续失败次数（成功即归零）
  error: string // 失败原因（HTTP 状态 / 异常消息 / 响应缺少状态字段）
  time: number // 事件时刻（Date.now()）
}

/** 业务扩展状态的键：必须落在 `app.` 命名空间内，避免与内核字段冲突 */
export type AppStateKey = `app.${string}`

// ───────────────────────────── 错误分级 ─────────────────────────────

export interface PlayerError {
  code: string // ERROR_CODE
  fatal: boolean // true=SDK 尽力后仍不可用，需接入方介入；false=自动重连中，可忽略
  message: string
  retryCount: number // 已重试次数
  diagnostic?: RetryDiagnostic // 触发本次重试时的地址 + 网络环境快照（便于排查）
}

/**
 * 重试诊断快照：每次触发重连时随错误一并上报，便于线上排查「哪条流、在什么网络下、重试到第几次失败」。
 * 通过 `Events.ERROR` 的 `PlayerError.diagnostic` 与上报插件 `ReportRecord.data.diagnostic` 双通道暴露。
 */
export interface RetryDiagnostic {
  url: string // 本次重试实际使用的播放地址（可能已切到 backup）
  primaryUrl: string // 业务下发的主地址（对比用，判断是否已切备用流）
  isBackup: boolean // 本次重试是否走的备用流
  networkQuality: NetworkQuality // 网络质量档（SDK 自适应策略的输入）
  online: boolean // navigator.onLine（EnvAdapter 判定）
  visibility: VisibilityState // 前台/后台
  effectiveType?: string // Network Information API: 4g / 3g / 2g / slow-2g
  downlink?: number // 估算下行带宽（Mbps）
  rtt?: number // 估算往返时延（ms）
  bufferBehind: number // 重试时刻落后 live edge 时长（s）
  bufferRemaining: number // 重试时刻缓冲剩余（s）
  currentTime: number // 重试时刻播放位置（s）
  retryCount: number // 第几次重试（从 1 起）
  delay: number // 本次退避延迟（ms）
  errorCode: string // 触发重试的错误码
  time: number // 触发时刻（Date.now()）
}

// ───────────────────────────── 上报 ─────────────────────────────

export interface ReportRecord {
  type: 'error' | 'metric' | 'event'
  code: string // ERROR_CODE 或指标名
  level: 'fatal' | 'warn' | 'info'
  data: Record<string, unknown>
  time: number
}

// ───────────────────────────── createPlayer 配置 ─────────────────────────────

export interface PlayerConfig {
  container: string | HTMLElement // 必填
  url?: string // 缺省主播放地址；服务端下发统一走 play(PlayConfig)
  kernel?: KernelConstructor // 缺省 sniffer 自动选
  hlsConfig?: Record<string, unknown> // 透传 hls.js 原生配置
  preset?: string | PluginConstructor[] // 插件组合，默认 'live'
  autoplay?: boolean // 默认 false；true = createPlayer 后自动发起一次 play()（需同时给 url）
  muted?: boolean // 默认 false
  ignores?: string[] // 关闭 Preset 内功能插件
  network?: Partial<NetworkConfig> // 网络敏感策略参数
  observability?: Observability // 默认 'full'
  env?: EnvAdapter // 默认 WebEnvAdapter
  posterMode?: PosterMode // 封面图呈现方式，默认 'native'（MSE 路径建议 'overlay'）
}

// ───────────────────────────── 插件 ─────────────────────────────

export interface PluginLifecycle {
  create(player: unknown): void
  init(config?: unknown): void
  ready(): void
  destroy(): void
}

/** 插件构造器（createPlayer 的 preset/plugins 数组元素） */
export interface PluginConstructor {
  new (): Plugin
  readonly pluginName?: string
}

/** 插件实例（BasePlugin 及 ReporterPlugin 的最小公共面） */
export interface Plugin extends PluginLifecycle {
  readonly name: string
}

/**
 * 插件注册入参：**构造器或实例皆可**（`player.registerPlugin(...)`）。
 * preset 数组仍只接受构造器（SDK 统一实例化）。
 */
export type PluginInput = PluginConstructor | Plugin

export interface ReporterPlugin extends Plugin {
  report(record: ReportRecord): void
  flush?(): void
}
