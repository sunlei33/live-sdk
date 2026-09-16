/**
 * 参考实现：把 live-sdk 的上报数据转发到 Sentry。
 *
 * ── 为什么它在 examples/ 而不是 SDK 里 ──
 *
 * Sentry 是**第三方系统能力**，绑定特定厂商。SDK 的边界是「只做把直播播出来这一件事」
 * （README 能力边界·类型四：非播放器核心职责 → 第三方能力由接入方接入）。
 * 核心只放**无第三方绑定的通用实现**（如 `ConsoleReporter`，用的是平台 `console`）。
 *
 * 因此 SDK 只提供**通道契约**（`BasePlugin` + `report(record)` + 分级/节流/采样），
 * 「往哪发」由接入方按自己的埋点体系实现。本文件是一份可直接复制的样板。
 *
 * ── 两个必须注意的点（都是踩过的坑）──
 *
 * ① **`record.data` 必须包在 `extra` 下**，不能平铺在 CaptureContext 顶层。
 *    Sentry 合并 CaptureContext 用的是**显式字段白名单**：`Scope.update()` 只读
 *    `tags` / `extra` / `contexts` / `user` / `level` / `fingerprint` / `requestSession` /
 *    `propagationContext`，且**没有任何 for...in 或透传机制**。
 *    平铺会让 `message` / `domain` / `retryCount` / `diagnostic` 被**静默丢弃** ——
 *    尤其 `diagnostic`（当前播放地址 + 网络环境 + 第几次重试）是最关键的排查信息，
 *    丢了等于接了 Sentry 反而看不到上下文。**客户端不会报错，只有亲眼去看 Sentry 才会发现。**
 *
 * ② **`level` 需要映射**：SDK 的 `ReportRecord.level` 是 `'fatal' | 'warn' | 'info'`，
 *    Sentry 的 `SeverityLevel` 是 `'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug'`
 *    —— 用 `'warning'`，**没有 `'warn'`**。直接透传会让等级落在无效值上、告警规则失效。
 *
 * ── 它被什么保护着 ──
 *
 * - 编译：`examples/tsconfig.json`，由 `npm run verify` 覆盖（示例不会腐烂）；
 * - 行为：`test/reporter-sentry-example.test.ts` 断言「到底发出去了什么」
 *   （`extra` 里有 diagnostic、除 level/extra 外无多余顶层键、三档 level 映射、breadcrumb 分流）。
 */

import { BasePlugin, type ReportRecord } from 'live-sdk'

/** Sentry 客户端的最小公共面（`@sentry/browser` 的 `Sentry` 对象天然满足，无需装类型包） */
export interface SentryLike {
  captureException(err: unknown, captureContext?: Record<string, unknown>): void
  addBreadcrumb?(crumb: Record<string, unknown>): void
}

/** SDK 的等级 → Sentry 的 `SeverityLevel`（注意 `'warn'` → `'warning'`） */
const SENTRY_LEVEL: Record<ReportRecord['level'], string> = {
  fatal: 'fatal',
  warn: 'warning',
  info: 'info',
}

/**
 * 只负责「往哪发」：`error` 走 `captureException`，
 * 其余（`metric` / `event`，如重连与业务手动 `report()`）走 `addBreadcrumb`
 * —— 形成「错误发生前的上下文轨迹」，这正是 Sentry 的典型用法。
 *
 * 经 config 注入 Sentry 实例，**不依赖 `@sentry/*` 的版本**。
 *
 * ```js
 * import * as Sentry from '@sentry/browser'
 * player.registerPlugin(SentryReporter, { sentry: Sentry })
 * // 或传实例（便于业务自己持有引用）：
 * // player.registerPlugin(new SentryReporter(), { sentry: Sentry })
 * ```
 */
export class SentryReporter extends BasePlugin {
  static readonly pluginName = 'sentryReporter'

  private sentry?: SentryLike

  init(config?: { sentry?: SentryLike }): void {
    this.sentry = config?.sentry
  }

  report(record: ReportRecord): void {
    if (!this.sentry) return // 未注入则降级为无操作，不打断播放
    const level = SENTRY_LEVEL[record.level] ?? 'info'

    if (record.type === 'error') {
      this.sentry.captureException(new Error(record.code), {
        level,
        // ⚠️ 这一层 `extra` 不能省，见文件头「注意点 ①」
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
