import type { NetworkConfig, NetworkQuality, PlayerConfig } from './types'

/**
 * 统一事件常量：值即对应的小写 snake_case 字符串，
 * 因此 `Events.FIRST_FRAME === 'first_frame'`，两种写法等价。
 */
export enum Events {
  LOAD_START = 'load_start',
  MANIFEST_PARSED = 'manifest_parsed',
  FIRST_FRAME = 'first_frame',
  PLAY = 'play',
  PAUSE = 'pause',
  PLAYING = 'playing',
  STALLED = 'stalled',
  RECOVERED = 'recovered',
  RETRY = 'retry',
  ERROR = 'error',
  ENDED = 'ended',
  QUALITY_CHANGE = 'quality_change',
  ABR_CHANGE = 'abr_change',
  BUFFER_UPDATE = 'buffer_update',
  SPEED_UPDATE = 'speed_update',
  VISIBILITY_CHANGE = 'visibility_change',
  FEATURES_UPDATED = 'features_updated',
  KERNEL_EVENT = 'kernel_event',
  /** 统一的命令观测事件（覆盖全部 12 个命令，见 `CommandEventPayload` / §6.4） */
  COMMAND = 'command',
}

/** 错误码常量表（控制台与上报双通道） */
export const ERROR_CODE = {
  CONFIG_RESOLVE_FAILED: 'config_resolve_failed',
  NO_SUPPORTED_KERNEL: 'no_supported_kernel',
  PLAY_FAILED: 'play_failed',
  MANIFEST_LOAD_ERROR: 'manifest_load_error',
  MANIFEST_404: 'manifest_404',
  FRAG_LOAD_ERROR: 'frag_load_error',
  NETWORK_ERROR: 'network_error',
  LOAD_TIMEOUT: 'load_timeout',
  RETRY_EXHAUSTED: 'retry_exhausted',
  DRM_NO_LICENSE: 'drm_no_license',
  /**
   * 解码失败（`MediaError.code === 3`）。重试无意义 —— 编码/码流问题不会因重连而消失，
   * 故一律 fatal。与 `network_error` 分开是为了让接入方的「解码异常 / 接口与 CDN 异常」
   * 分流不至于错位（见 utils/errors.ts#mapMediaErrorCode）。
   */
  MEDIA_DECODE_ERROR: 'media_decode_error',
  /** 源容器/格式不被当前内核支持（`MediaError.code === 4` 且无网络痕迹），fatal。 */
  MEDIA_SRC_NOT_SUPPORTED: 'media_src_not_supported',
  UNKNOWN: 'unknown',
} as const

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE]

/**
 * 错误**域**：把 `ERROR_CODE` 收敛到「**该去哪儿排查**」的三个方向（外加一个 unknown 兜底）。
 *
 * 为什么要单独一层：错误码是**枚举**（13 个、还会随版本增加），而接入方的可观测看板只关心
 * 粗粒度的**归因方向**——「这是服务端/CDN 的问题、内容的问题，还是我自己接错了」。
 * 没有这一层时，每个接入方都得自己维护「code → 方向」的映射表，并且**新增错误码时必然漏同步**
 * （实测某业务为此写了 20+ 行的两个 Set + 关键词兜底，仍不保证与 SDK 一致）。
 *
 * | 域 | 归因方向 | 典型表现 |
 * |---|---|---|
 * | `network` | **服务端 / CDN / 链路** | 主 playlist 与分片拉不到、超时、重试耗尽 |
 * | `decode` | **内容 / 转码 / 播放内核** | 解码失败、容器格式不被支持、DRM 无 license |
 * | `config` | **接入侧配置 / 平台能力** | 起播配置解析失败、无可用内核、自动播放被策略拦截 |
 * | `unknown` | **未归类** | 新增或未覆盖的错误码；**不猜**，由接入方自行决定如何处理 |
 *
 * 关于 `unknown` 为什么独立成一档：别把它悄悄并进某一域。并入 `decode`（"播放器自己的问题"）
 * 是最常见的做法，代价是**真实的未知故障会被伪装成解码问题**，排查方向直接跑偏。
 * 如实暴露 `unknown` 才能让「映射表漏了」这件事被看见。
 */
export const ERROR_DOMAIN = {
  NETWORK: 'network',
  DECODE: 'decode',
  CONFIG: 'config',
  UNKNOWN: 'unknown',
} as const

export type ErrorDomain = (typeof ERROR_DOMAIN)[keyof typeof ERROR_DOMAIN]

/**
 * 命令名：`COMMAND` 事件的 `name` 字段，与 `PlayerCommands` 的键一一对应（**12 个，全覆盖**）。
 * 放在常量里而非从类型推导，是为了让运行时也能枚举校验（见 `verify/smoke.mjs`）。
 */
export const COMMAND_NAMES = [
  'play',
  'pause',
  'mute',
  'setVolume',
  'switchQuality',
  'switchURL',
  'requestFullscreen',
  'exitFullscreen',
  'seek',
  'setPlaybackRate',
  'setPoster',
  'setLiveLatency',
] as const

export type CommandName = (typeof COMMAND_NAMES)[number]

/**
 * 缓冲水位分档边界（秒，升序）。`BUFFER_UPDATE` 的派发判据。
 *
 * **为什么需要它**：缓冲水位只随 `timeupdate` / `progress` 变化（~4Hz），
 * 若每次都派发，等于给所有订阅方塞了一条 4Hz 的高频流，与「快照只放低频字段」的
 * 整体节流原则冲突；若干脆不派发，接入方就只能自开 `setInterval` 轮询 `bufferInfo()`。
 *
 * 折中：把「剩余可播时长」映射到离散档位（0~5），**只在跨越边界时**派发。
 * 语义上这正是订阅方真正关心的信息 ——「缓冲水位档位变了」，
 * 而不是「缓冲又多了 0.07 秒」。低缓冲预警（如 `level <= 1`）因此变成一次订阅即可。
 *
 * 边界取 `[1, 3, 5, 10, 20]` 秒：1s 是「即将卡死」的硬线，3/5s 是弱网下的常见危险区，
 * 10/20s 区分「缓冲充裕」与「缓冲非常充裕」。需要自定义阈值的接入方仍可直接读
 * 载荷里的原始 `remaining` / `totalRemaining` 自行判定。
 */
export const BUFFER_LEVEL_THRESHOLDS = [1, 3, 5, 10, 20] as const

/** 由「当前块剩余可播时长（秒）」求缓冲档位；`level` 越大越充裕（0 ~ 5）。 */
export function bufferLevelOf(remaining: number): number {
  let level = 0
  for (const t of BUFFER_LEVEL_THRESHOLDS) {
    if (remaining >= t) level++
    else break
  }
  return level
}

/** 会话状态集合 */
export type SessionState =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'stalled'
  | 'error'
  | 'ended'

/**
 * 内置网络动态策略（方向：网络越差越保守）。
 * offline 档不参与数值调整——断网走断流重连，而非降延迟/降超时。
 */
export const DEFAULT_NETWORK_STRATEGY: NetworkConfig = {
  targetLatency: (q: NetworkQuality) => (q === 'poor' ? 20 : q === 'fair' ? 12 : 8),
  maxLatency: (q: NetworkQuality) => (q === 'poor' ? 40 : q === 'fair' ? 24 : 16),
  retryCount: (q: NetworkQuality) => (q === 'poor' ? 8 : q === 'fair' ? 4 : 2),
  retryDelay: (q: NetworkQuality) => (q === 'poor' ? 3000 : q === 'fair' ? 1500 : 500),
  loadTimeout: (q: NetworkQuality) => (q === 'poor' ? 20000 : q === 'fair' ? 12000 : 8000),
}

/** 配置默认值（deep merge 的底层） */
export const DEFAULT_CONFIG: Required<PlayerConfig> = {
  container: '',
  url: undefined,
  kernel: undefined,
  hlsConfig: {},
  preset: 'live',
  autoplay: false,
  muted: false,
  ignores: [],
  network: { ...DEFAULT_NETWORK_STRATEGY },
  observability: 'full',
  env: undefined,
  posterMode: 'native',
} as unknown as Required<PlayerConfig>
