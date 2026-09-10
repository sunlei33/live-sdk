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
export { WebEnvAdapter } from './env/WebEnvAdapter'
export { ConsoleReporter } from './reporter/ConsoleReporter'
export { SentryReporter } from './reporter/SentryReporter'
export type { SentryLike } from './reporter/SentryReporter'
export { LivePolling } from './plugins/LivePolling'

// —— 常量 ——
export { Events, ERROR_CODE } from './constants'

// —— 工具 ——
export { deepMerge, resolveContainer } from './utils/config'
export * as sniffer from './utils/sniffer'
export { logger, setLogLevel } from './utils/logger'

// —— 类型 ——
export type {
  Observability,
  KernelCapabilities,
  StatsInfo,
  BufferInfo,
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
  NetworkTunable,
  NetworkConfig,
  FeatureKey,
  SideState,
  FeatureStatus,
  FeatureStatusReport,
  PlayerError,
  RetryDiagnostic,
  ReportRecord,
  PlayerConfig,
  PluginLifecycle,
  Plugin,
  PluginConstructor,
  ReporterPlugin,
} from './types'
