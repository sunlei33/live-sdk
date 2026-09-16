import { describe, it, expect, vi } from 'vitest'
// 直接 import 参考实现本身（而非复制一份断言）——
// 这样示例里若把 `extra` 包装写掉、或漏了 level 映射，这里会立刻失败。
import { SentryReporter, type SentryLike } from '../examples/reporter-sentry'
import type { ReportRecord } from '../src/types'

/**
 * 为什么给一个「示例文件」写测试：
 *
 * `SentryReporter` 曾在 SDK 内且**零单测**，`verify/contract.ts` 只验证到「能注册」为止 ——
 * 于是「把 `record.data` 平铺在 CaptureContext 顶层」这个缺陷一路活着：
 * Sentry 只会把它**静默丢弃**，客户端不报错、测试也不失败。
 *
 * 它现在迁到 `examples/`（第三方适配不属核心公开面），但**这条教训不能一起搬走**：
 * 示例是接入方会直接复制的代码，错的示例比没有示例更坏。
 * 因此断言重点是**「到底发出去了什么」**，而不只是「发出了」。
 */

function makeFakeSentry() {
  const captured: Array<{ err: unknown; ctx: Record<string, unknown> }> = []
  const crumbs: Array<Record<string, unknown>> = []
  const sentry: SentryLike = {
    captureException: (err, ctx) => captured.push({ err, ctx: ctx ?? {} }),
    addBreadcrumb: (c) => crumbs.push(c),
  }
  return { sentry, captured, crumbs }
}

const errorRecord = (over: Partial<ReportRecord> = {}): ReportRecord => ({
  type: 'error',
  code: 'manifest_404',
  level: 'fatal',
  data: {
    message: '主 playlist 404',
    domain: 'network',
    retryCount: 0,
    diagnostic: { url: 'https://cdn/a.m3u8', networkQuality: 'good' },
  },
  time: 1,
  ...over,
})

describe('examples/reporter-sentry（参考实现）', () => {
  it('【回归】诊断快照必须进 extra —— 平铺在顶层会被 Sentry 静默丢弃', async () => {
    // Sentry 的 Scope.update() 对普通对象走显式白名单
    // （tags / extra / contexts / user / level / fingerprint / …），**没有 for...in 透传**，
    // 顶层未知键一律丢弃。这正是本示例头注释里「注意点 ①」在守的东西。
    const { sentry, captured } = makeFakeSentry()
    const p = new SentryReporter()
    p.init({ sentry })
    p.report(errorRecord())

    expect(captured).toHaveLength(1)
    const ctx = captured[0].ctx
    const extra = ctx.extra as Record<string, unknown>
    expect(extra.diagnostic).toEqual({ url: 'https://cdn/a.m3u8', networkQuality: 'good' })
    expect(extra.message).toBe('主 playlist 404')
    expect(extra.domain).toBe('network')
    expect(extra.retryCount).toBe(0)
    expect(extra.code).toBe('manifest_404')
    // 反向断言：除 level / extra 外不应有其它顶层键（有则说明又平铺了）
    expect(Object.keys(ctx).sort()).toEqual(['extra', 'level'])
  })

  it('【回归】level 做映射：SDK 的 warn → Sentry 的 warning', async () => {
    // Sentry 的合法等级是 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug'，
    // **没有 'warn'** —— 直接透传会让等级落在 Sentry 不认识的值上。见头注释「注意点 ②」。
    const { sentry, captured } = makeFakeSentry()
    const p = new SentryReporter()
    p.init({ sentry })

    p.report(errorRecord({ level: 'fatal' }))
    p.report(errorRecord({ level: 'warn' }))
    p.report(errorRecord({ level: 'info' }))

    expect(captured.map((c) => c.ctx.level)).toEqual(['fatal', 'warning', 'info'])
  })

  it('error 走 captureException；非 error 走 addBreadcrumb（形成上下文轨迹）', () => {
    const { sentry, captured, crumbs } = makeFakeSentry()
    const p = new SentryReporter()
    p.init({ sentry })

    p.report(errorRecord())
    p.report({ type: 'event', code: 'retry', level: 'warn', data: { message: '断流重连' }, time: 2 })
    p.report({ type: 'metric', code: 'firstFrameCost', level: 'info', data: { ms: 800 }, time: 3 })

    expect(captured).toHaveLength(1) // 只有 error 进 exception
    expect(crumbs).toHaveLength(2)
    expect(crumbs[0]).toMatchObject({ category: 'event', message: 'retry', level: 'warning' })
    expect(crumbs[1]).toMatchObject({ category: 'metric', message: 'firstFrameCost' })
  })

  it('未注入 sentry 时静默返回（降级为无操作，不打断播放）', () => {
    const p = new SentryReporter()
    p.init(undefined)
    expect(() => p.report(errorRecord())).not.toThrow()
  })

  it('sentry 未实现可选的 addBreadcrumb 时，error 上报不受影响', () => {
    const captured: Array<Record<string, unknown>> = []
    const minimal: SentryLike = { captureException: (_e, ctx) => captured.push(ctx ?? {}) }
    const p = new SentryReporter()
    p.init({ sentry: minimal })

    p.report(errorRecord())
    expect(() => p.report({ type: 'event', code: 'retry', level: 'warn', data: {}, time: 4 })).not.toThrow()
    expect(captured).toHaveLength(1)
  })

  it('pluginName 固定为 sentryReporter（ignores 按此裁剪）', () => {
    expect(SentryReporter.pluginName).toBe('sentryReporter')
  })

  it('插件自身不吞异常 —— 由 Player.dispatchReport 统一 try/catch 兜底', () => {
    // 固定这条边界：插件内不再包一层 try/catch，避免「双层兜底」掩盖真实错误位置。
    const boom: SentryLike = {
      captureException: vi.fn(() => {
        throw new Error('sentry down')
      }),
    }
    const p = new SentryReporter()
    p.init({ sentry: boom })
    expect(() => p.report(errorRecord())).toThrow('sentry down')
  })
})
