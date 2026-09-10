/**
 * live-sdk 全部共享类型定义。
 * 与 docs/live-sdk-spec.md 的 API 面逐字对齐，是「内核 / 插件 / 接入方」三方契约的唯一来源。
 */

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
  autoplay?: boolean // 自动播放
  muted?: boolean // 静音
  poster?: string // 封面图
  quality?: Quality[] // 清晰度档位元数据（业务下发）
}

export type PlayConfigProvider = () => PlayConfig | Promise<PlayConfig>
export type PlayInput = string | PlayConfig | PlayConfigProvider

// ───────────────────────────── 三契约（命令 / 状态 / 事件） ─────────────────────────────

export interface PlayerCommands {
  play(config?: PlayInput): Promise<void>
  pause(): void
  mute(m: boolean): void
  setVolume(v: number): void
  switchQuality(id: number): void
  switchURL(url: string): Promise<void>
  requestFullscreen(): void
}

export interface PlayerState {
  playing: boolean
  volume: number
  muted: boolean
  qualities: Quality[] // 有效档位列表（PlayConfig.quality 中已映射到 streams 的部分）
  currentQuality: number | null // 当前档位（Quality.id）；未切档/无档时为 null
  capabilities: KernelCapabilities
  [ext: `app.${string}`]: unknown // 扩展点：插件/业务命名空间，内核不预设
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
  autoplay?: boolean // 默认 false
  muted?: boolean // 默认 false
  ignores?: string[] // 关闭 Preset 内功能插件
  network?: Partial<NetworkConfig> // 网络敏感策略参数
  observability?: Observability // 默认 'full'
  env?: EnvAdapter // 默认 WebEnvAdapter
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

export interface ReporterPlugin extends Plugin {
  report(record: ReportRecord): void
  flush?(): void
}
