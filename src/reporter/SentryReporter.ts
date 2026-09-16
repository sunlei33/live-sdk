import { BasePlugin } from '../core/BasePlugin'
import type { ReportRecord } from '../types'

/**
 * Sentry 客户端的最小公共面（`@sentry/browser` 的 `Sentry` 对象天然满足）。
 * SDK 不硬依赖 `@sentry/*`，接入方把自己的 Sentry 实例经 config 注入。
 *
 * `captureException` 的第二个参数是 Sentry 的 **CaptureContext**（`Partial<ScopeContext>`）。
 * 注意它**不是自由对象**：自定义数据必须放在 `extra` / `contexts` / `tags` 下，
 * 顶层未知键会被**静默丢弃**（见 `report()` 里的说明）。
 */
export interface SentryLike {
  captureException(err: unknown, captureContext?: Record<string, unknown>): void
  addBreadcrumb?(crumb: Record<string, unknown>): void
}

/**
 * SDK 的 `ReportRecord.level` → Sentry `SeverityLevel`。
 *
 * 两者取值**并不相同**：SDK 用 `'warn'`，Sentry 用 `'warning'`
 * （Sentry 的合法值是 `'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug'`）。
 * 直接透传会让 `'warn'` 落到一个 Sentry 不认识的值上，等级筛选/告警规则随之失效。
 */
const SENTRY_LEVEL: Record<ReportRecord['level'], string> = {
  fatal: 'fatal',
  warn: 'warning',
  info: 'info',
}

/**
 * SentryReporter：官方上报插件（spec §5.3）。只负责「往哪发」：
 * `error` 记录走 `captureException`，其余（`metric` / `event`，如重连与业务手动 report）
 * 走 `addBreadcrumb` —— 形成「错误发生前的上下文轨迹」，这正是 Sentry 的典型用法。
 *
 * 经 config 注入 Sentry 实例，避免 SDK 直接依赖 `@sentry/browser` 及其版本。
 *
 * 用法：`player.registerPlugin(SentryReporter, { sentry: Sentry })`
 */
export class SentryReporter extends BasePlugin {
  static readonly pluginName = 'sentryReporter'

  private sentry?: SentryLike

  init(config?: { sentry?: SentryLike }): void {
    this.sentry = config?.sentry
  }

  report(record: ReportRecord): void {
    if (!this.sentry) return
    const level = SENTRY_LEVEL[record.level] ?? 'info'

    if (record.type === 'error') {
      // ⚠️ `extra` 这一层包装不能省。
      //
      // Sentry 合并 CaptureContext 时用的是**显式字段白名单**：`Scope.update()` 只读
      // `tags` / `extra` / `contexts` / `user` / `level` / `fingerprint` / `requestSession` /
      // `propagationContext`，且**没有 for...in 或任何透传机制**。
      // 因此若把 `record.data` 平铺在顶层（`{ level, ...record.data }`），
      // 其中的 `message` / `retryCount` / `diagnostic` 会被**静默丢弃** ——
      // 尤其 `diagnostic`（当前播放地址 + 网络环境 + 第几次重试）是 SDK 最核心的排查信息，
      // 丢了等于接 Sentry 反而看不到关键上下文。必须走 `extra`。
      this.sentry.captureException(new Error(record.code), {
        level,
        extra: { code: record.code, ...record.data },
      })
      return
    }

    this.sentry.addBreadcrumb?.({
      category: record.type,
      message: record.code,
      level,
      data: record.data,
    })
  }
}
