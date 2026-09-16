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
