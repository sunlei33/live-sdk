import { BasePlugin } from '../core/BasePlugin'
import type { ReportRecord } from '../types'

/**
 * Sentry 客户端的最小公共面（@sentry/browser 的 Sentry 对象天然满足）。
 * SDK 不硬依赖 @sentry/*，接入方把自己的 Sentry 实例经 config 注入。
 */
export interface SentryLike {
  captureException(err: unknown, extra?: Record<string, unknown>): void
  addBreadcrumb?(crumb: Record<string, unknown>): void
}

/**
 * SentryReporter：官方可选上报插件（spec §5.3「官方提供 SentryReporter 可选包」）。
 * 只负责「往哪发」：error 记录走 captureException，非 error 走 addBreadcrumb（若有）。
 * 经 config 注入 Sentry 实例，避免 SDK 直接依赖 @sentry/browser。
 *
 * 用法：player.registerPlugin(SentryReporter, { sentry: Sentry })
 */
export class SentryReporter extends BasePlugin {
  static readonly pluginName = 'sentryReporter'

  private sentry?: SentryLike

  init(config?: { sentry?: SentryLike }): void {
    this.sentry = config?.sentry
  }

  report(record: ReportRecord): void {
    if (!this.sentry) return
    if (record.type === 'error') {
      this.sentry.captureException(new Error(record.code), {
        level: record.level,
        ...record.data,
      })
    } else if (this.sentry.addBreadcrumb) {
      this.sentry.addBreadcrumb({
        category: record.type,
        message: record.code,
        level: record.level,
        data: record.data,
      })
    }
  }
}
