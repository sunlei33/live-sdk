/**
 * live-sdk 主入口：headless H5 直播播放器 SDK（HLS + fMP4 + hls.js）。
 * 内核只暴露「状态/命令/事件」三契约，UI 完全外置。
 */
import { Player } from './core/Player'
import { createWebPlatform } from './platform/web'
import type { PlayerConfig } from './types'

/**
 * 创建播放器（接入方唯一入口）。
 *
 * 本函数是**装配层**：把 Web 平台实现打成 `PlatformAdapters` 交给 `core/Player`。
 * 这是 P0「解耦」的落点 —— core 不再 `import` 任何实现（内核 / env / 默认插件 / 媒体面），
 * 因此「换媒体面、换宿主、换内核」都不需要改 core。分层约束由 `verify/layers.mjs` 强制。
 */
export function createPlayer(config: PlayerConfig): Player {
  return new Player(config, createWebPlatform({ kernel: config.kernel }))
}

// —— 核心 ——
export { Player } from './core/Player'
export { BasePlugin } from './core/BasePlugin'
export { UIMount } from './ui/index'

// —— 内核 ——
export { HlsKernel } from './kernel/HlsKernel'
export { NativeKernel } from './kernel/NativeKernel'

// —— 适配 / 上报 / 插件 ——
// 注：**不含 Sentry / 其它第三方上报适配器**。SDK 只提供上报**通道契约**
// （`BasePlugin` + `report(record)` + 分级/节流/采样），「往哪发」由接入方实现。
// 理由见 README 能力边界·类型四（第三方系统能力不属播放器核心职责）；
// 可直接复制的 Sentry 样板见 `examples/reporter-sentry.ts`。
export { WebEnvAdapter } from './env/WebEnvAdapter'
// 随 SDK 附带、经 `preset` / `registerPlugin` 装配的插件都在 `plugins/`
// （`ConsoleReporter` 与 `LivePolling` 同属 `preset.live`，故同目录）
export { ConsoleReporter } from './plugins/ConsoleReporter'
export { LivePolling, LIVE_STATUS_ERROR_EVENT } from './plugins/LivePolling'
export type { LiveStatus } from './plugins/LivePolling'

// —— 常量 ——
export {
  Events,
  ERROR_CODE,
  ERROR_DOMAIN,
  MSG,
  DEFAULT_LOCALE,
  BUFFER_LEVEL_THRESHOLDS,
  bufferLevelOf,
  COMMAND_NAMES,
} from './constants'
export type { SessionState, ErrorDomain, CommandName, MsgId } from './constants'

// —— 工具 ——
// 注：原先在这里导出的 `sniffer` 命名空间已移除 —— 它整个模块都是 Web 平台实现，
// 按语义拆成两处：媒体设备能力 → `MediaSurface.canPlay()`（契约），宿主能力 → `platform/web/capabilities`。
export { deepMerge } from './utils/config'
export { logger, setLogLevel } from './utils/logger'
// 运行期消息语言（全局，与 setLogLevel 同类语义）：默认 `'en'`，`setLocale('zh')` 切中文。
// 消息编号 → 中英文案的对照表在 `utils/messages.ts`。
export { setLocale, getLocale } from './utils/i18n'
export { errorDomainOf } from './utils/errors'
export { isZeroSized } from './utils/size'
export type { ElementSize } from './utils/size'
// 以下两者读 DOM（`querySelector` / `getBoundingClientRect`），实现位于 Web 平台层；
// 顶层导出名不变（P1 迁移：读平台的搬出 `utils/`，纯的留下）
export { resolveContainer, readElementSize } from './platform/web/dom'

// —— 类型 ——
export type {
  Observability,
  Locale,
  KernelCapabilities,
  StatsInfo,
  BufferInfo,
  BufferUpdatePayload,
  HookPhase,
  CommandHookContext,
  SpeedInfo,
  LevelInfo,
  Kernel,
  KernelConstructor,
  KernelOptions,
  NetworkQuality,
  VisibilityState,
  EnvAdapter,
  // —— 平台契约（自绘/自实现平台用；Web 实现已由 createPlayer 注入，多数接入方用不到）——
  MediaSurface,
  MediaEventName,
  MediaErrorInfo,
  HostMount,
  PlatformAdapters,
  Quality,
  PlayConfig,
  PlayConfigProvider,
  PlayInput,
  PlayerCommands,
  PlayerState,
  SessionReport,
  NetworkTunable,
  NetworkConfig,
  FeatureKey,
  SideState,
  FeatureStatus,
  FeatureStatusReport,
  LiveStatusPayload,
  LiveStatusErrorPayload,
  CommandEventPayload,
  AppStateKey,
  PlayerError,
  RetryDiagnostic,
  ReportRecord,
  PlayerConfig,
  PosterMode,
  PluginLifecycle,
  Plugin,
  PluginConstructor,
  PluginInput,
  ReporterPlugin,
} from './types'
