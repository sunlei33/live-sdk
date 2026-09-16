/**
 * 公开面清单（single source of truth）
 *
 * 由两道门共同消费，避免「清单只有一份、但两个脚本各抄一遍」而逐渐漂移：
 * - `verify/exports.mjs` —— 校验公开面的**形状**（名字集合与预期一致，缺失/多余都失败）
 * - `verify/surface.mjs` —— 校验公开面的**活性**（有没有内部消费者或测试覆盖）
 *
 * **改动这里的任何一行都等于修改对外契约。** 新增导出必须登记，否则 exports.mjs 报「多余」。
 */

/** 顶层导出（core，`live-sdk` 主入口） */
export const CORE = [
  'BUFFER_LEVEL_THRESHOLDS',
  'BasePlugin',
  'COMMAND_NAMES',
  'ConsoleReporter',
  'ERROR_CODE',
  'ERROR_DOMAIN',
  'Events',
  'HlsKernel',
  'LIVE_STATUS_ERROR_EVENT',
  'LivePolling',
  'NativeKernel',
  'Player',
  'SentryReporter',
  'UIMount',
  'WebEnvAdapter',
  'bufferLevelOf',
  'createPlayer',
  'deepMerge',
  'errorDomainOf',
  'isZeroSized',
  'logger',
  'readElementSize',
  'resolveContainer',
  'setLogLevel',
  'sniffer',
]

/** 顶层导出（`live-sdk/ui`） */
export const UI = [
  'UIMount',
  'UIPlugin',
  'bindPress',
  'PlayButton',
  'MuteButton',
  'VolumeControl',
  'QualityPanel',
  'FullscreenButton',
  'mountDefaultUI',
]

/** 命名空间成员（`sniffer.*`）。只保留能力探测 —— UA 嗅探已于 0.5.0 删除。 */
export const SNIFFER = ['canPlayNativeHLS', 'canPlayNativeMP4', 'supportsMSE', 'supportsManagedMediaSource']

/** `Events` 枚举成员（19 个，`COMMAND` 为统一命令观测） */
export const EVENTS = [
  'ABR_CHANGE',
  'BUFFER_UPDATE',
  'COMMAND',
  'ENDED',
  'ERROR',
  'FEATURES_UPDATED',
  'FIRST_FRAME',
  'KERNEL_EVENT',
  'LOAD_START',
  'MANIFEST_PARSED',
  'PAUSE',
  'PLAY',
  'PLAYING',
  'QUALITY_CHANGE',
  'RECOVERED',
  'RETRY',
  'SPEED_UPDATE',
  'STALLED',
  'VISIBILITY_CHANGE',
]

/** `ERROR_CODE` 成员（13 个） */
export const ERROR_CODE = [
  'CONFIG_RESOLVE_FAILED',
  'DRM_NO_LICENSE',
  'FRAG_LOAD_ERROR',
  'LOAD_TIMEOUT',
  'MANIFEST_404',
  'MANIFEST_LOAD_ERROR',
  'MEDIA_DECODE_ERROR',
  'MEDIA_SRC_NOT_SUPPORTED',
  'NETWORK_ERROR',
  'NO_SUPPORTED_KERNEL',
  'PLAY_FAILED',
  'RETRY_EXHAUSTED',
  'UNKNOWN',
]

/** `ERROR_DOMAIN` 成员（4 个：归因方向） */
export const ERROR_DOMAIN = ['CONFIG', 'DECODE', 'NETWORK', 'UNKNOWN']

/** `COMMAND_NAMES` 内容 —— 即 `COMMAND` 事件的 name 字段，与 PlayerCommands 的键一一对应 */
export const COMMAND_NAMES = [
  'exitFullscreen',
  'mute',
  'pause',
  'play',
  'requestFullscreen',
  'seek',
  'setLiveLatency',
  'setPlaybackRate',
  'setPoster',
  'setVolume',
  'switchQuality',
  'switchURL',
]

/** `BUFFER_LEVEL_THRESHOLDS` 内容 */
export const BUFFER_THRESHOLDS = [1, 3, 5, 10, 20]

/**
 * `Player` 的**公开方法**契约。
 *
 * 注意：**不是** `Player.prototype` 的全量 —— 原型上还挂着 ~60 个内部方法
 * （TS 的 `private` 只在编译期生效，运行时它们与公开方法无法区分）。
 * 因此 exports.mjs 对它只做「必须存在」的单向校验，新增内部方法不会误报。
 */
export const PLAYER_PUBLIC = [
  // PlayerCommands（12 条，与 COMMAND_NAMES 对应）
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
  // 状态契约
  'getState',
  'subscribe',
  'setAppState',
  // 事件契约
  'on',
  'off',
  'once',
  'emit',
  // 指标与诊断
  'getStats',
  'bufferInfo',
  'speedInfo',
  'getSessionReport',
  'getFeatureStatus',
  'getLastRetryDiagnostic',
  // 插件与钩子
  'registerPlugin',
  'unregisterPlugin',
  'useHooks',
  'onDestroy',
  // 其它
  'report',
  'pollLiveStatus',
  'getKernel',
  'destroy',
]

/**
 * 供 surface.mjs 遍历的分组视图。
 *
 * `kind` 决定「消费者」的匹配方式（见 surface.mjs）：
 * - `identifier`：模块级导出 / 命名空间成员 —— 按**裸词**统计；
 * - `member`：类实例方法 —— 按**成员访问**（`.name`）统计。
 *   若也按裸词统计，`on` / `off` / `emit` 这类常用词会被注释与其他调用大量命中，
 *   判据等于失效。按 `.name` 匹配才对应「有没有人以成员方式访问过它」。
 */
export const GROUPS = [
  { key: 'core', label: 'core 顶层导出', names: CORE, kind: 'identifier' },
  { key: 'ui', label: 'ui 顶层导出', names: UI, kind: 'identifier' },
  { key: 'sniffer', label: 'sniffer 成员', names: SNIFFER, kind: 'identifier' },
  { key: 'events', label: 'Events 成员', names: EVENTS, kind: 'identifier' },
  { key: 'errorCode', label: 'ERROR_CODE 成员', names: ERROR_CODE, kind: 'identifier' },
  { key: 'errorDomain', label: 'ERROR_DOMAIN 成员', names: ERROR_DOMAIN, kind: 'identifier' },
  { key: 'commandNames', label: 'COMMAND_NAMES', names: COMMAND_NAMES, kind: 'identifier' },
  { key: 'playerPublic', label: 'Player 公开方法', names: PLAYER_PUBLIC, kind: 'member' },
]
