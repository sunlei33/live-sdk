import { describe, it, expect, vi } from 'vitest'
import { SentryReporter, type SentryLike } from '../src/reporter/SentryReporter'
import type { ReportRecord } from '../src/types'

/**
 * 本文件的存在理由：`SentryReporter` 此前**零单测**，`verify/contract.ts` 只验证到
 * 「能注册」为止 —— 于是「把 `record.data` 平铺在 CaptureContext 顶层」这个缺陷
 * 一路活着：Sentry 只会把它**静默丢弃**，客户端不报错、测试也不失败。
 *
 * 因此这里的断言重点是**「到底发出去了什么」**，而不只是「发出了」。
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

describe('SentryReporter', () => {
  it('【回归】诊断快照必须进 extra —— 平铺在顶层会被 Sentry 静默丢弃', async () => {
    // Sentry 的 Scope.update() 对普通对象走显式白名单
    // （tags / extra / contexts / user / level / fingerprint / …），
    // **没有 for...in 透传**，顶层未知键一律丢弃。
    const { sentry, captured } = makeFakeSentry()
    const p = new SentryReporter()
    p.init({ sentry })
    p.report(errorRecord())

    expect(captured).toHaveLength(1)
    const ctx = captured[0].ctx
    expect(ctx.extra).toBeDefined()
    const extra = ctx.extra as Record<string, unknown>
    expect(extra.diagnostic).toEqual({ url: 'https://cdn/a.m3u8', networkQuality: 'good' })
    expect(extra.message).toBe('主 playlist 404')
    expect(extra.domain).toBe('network')
    expect(extra.retryCount).toBe(0)
    // code 同时进 extra，便于在 Sentry 里按错误码检索
    expect(extra.code).toBe('manifest_404')
    // 反向断言：除 level / extra 外不应有其它顶层键（那说明又平铺了）
    expect(Object.keys(ctx).sort()).toEqual(['extra', 'level'])
  })

  it('【回归】level 做映射：SDK 的 warn → Sentry 的 warning', async () => {
    // Sentry 的合法等级是 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug'，
    // **没有 'warn'** —— 直接透传会让等级落在 Sentry 不认识的值上。
    const { sentry, captured } = makeFakeSentry()
    const p = new SentryReporter()
    p.init({ sentry })

    p.report(errorRecord({ level: 'fatal' }))
    p.report(errorRecord({ level: 'warn' }))
    p.report(errorRecord({ level: 'info' }))

    expect(captured.map((c) => c.ctx.level)).toEqual(['fatal', 'warning', 'info'])
  })

  it('error 记录走 captureException；非 error 走 addBreadcrumb（形成上下文轨迹）', () => {
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

  it('未注入 sentry 时静默返回（不抛错、不崩播放）', () => {
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

  it('reporter 抛错不应冒泡到播放主流程（dispatchReport 的兜底在 Player 侧）', () => {
    // 这里只固定「本插件自身不吞异常、由 Player 统一兜底」的边界：
    // Player.dispatchReport 用 try/catch 包住每个 rp.report()，故插件内无需再包一层。
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
