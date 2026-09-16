/**
 * live-sdk 主入口：headless H5 直播播放器 SDK（HLS + fMP4 + hls.js）。
 * 内核只暴露「状态/命令/事件」三契约，UI 完全外置。
 */
import { Player } from './core/Player'
import type { PlayerConfig } from './types'

/** 创建播放器（工厂）：返回 Player 实例，内核 headless，UI 由接入方装配 */
export function createPlayer(config: PlayerConfig): Player {
  return new Player(config)
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
export { ConsoleReporter } from './reporter/ConsoleReporter'
export { LivePolling, LIVE_STATUS_ERROR_EVENT } from './plugins/LivePolling'
export type { LiveStatus } from './plugins/LivePolling'

// —— 常量 ——
export { Events, ERROR_CODE, ERROR_DOMAIN, BUFFER_LEVEL_THRESHOLDS, bufferLevelOf, COMMAND_NAMES } from './constants'
export type { SessionState, ErrorDomain, CommandName } from './constants'

// —— 工具 ——
export { deepMerge, resolveContainer } from './utils/config'
export * as sniffer from './utils/sniffer'
export { logger, setLogLevel } from './utils/logger'
export { errorDomainOf } from './utils/errors'
export { readElementSize, isZeroSized } from './utils/size'
export type { ElementSize } from './utils/size'

// —— 类型 ——
export type {
  Observability,
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
