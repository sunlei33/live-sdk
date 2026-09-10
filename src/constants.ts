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
  UNKNOWN: 'unknown',
} as const

export type ErrorCode = (typeof ERROR_CODE)[keyof typeof ERROR_CODE]

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
} as unknown as Required<PlayerConfig>
