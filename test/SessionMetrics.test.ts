import { describe, it, expect } from 'vitest'
import { SessionMetrics } from '../src/core/SessionMetrics'

/**
 * `SessionMetrics` 单测：**不需要 Player、不需要 DOM、不需要内核** —— 这正是把它抽出来的收益。
 *
 * 时钟由构造参数注入，所以「进行中时段实时计入」「离开路径统一结算」这类最容易算错的点
 * 都可以确定性断言，不必依赖真实时间（同 `Player#lastErrorDedup` 去重窗口的 `vi.setSystemTime` 用法）。
 */
function withClock(start = 1000) {
  let t = start
  let calls = 0
  return {
    metrics: new SessionMetrics(() => {
      calls++
      return t
    }),
    /** 前进（不触发读钟计数） */
    advance(ms: number) {
      t += ms
    },
    set(ms: number) {
      t = ms
    },
    get clockCalls() {
      return calls
    },
  }
}

describe('SessionMetrics：两段式记录（已结算累计 + 进行中起点）', () => {
  it('未起播时报告全为空', () => {
    const { metrics } = withClock()
    expect(metrics.report()).toEqual({
      firstFrameCost: null,
      stallCount: 0,
      stallDuration: 0,
      watchTime: 0,
      loadStartTime: null,
    })
  })

  it('reset() 记录起播时刻，首帧耗时 = 首帧时刻 − 起播时刻', () => {
    const c = withClock(1000)
    c.metrics.reset()
    c.set(1345)
    c.metrics.markFirstFrame()
    expect(c.metrics.report().firstFrameCost).toBe(345)
    expect(c.metrics.report().loadStartTime).toBe(1000)
  })

  it('首帧耗时幂等：记录后再次调用不改写', () => {
    const c = withClock(1000)
    c.metrics.reset()
    c.set(1100)
    c.metrics.markFirstFrame()
    c.set(9000)
    c.metrics.markFirstFrame()
    expect(c.metrics.report().firstFrameCost).toBe(100)
  })

  it('未经 reset()（未起播）时 markFirstFrame 不记录 —— 没有起播基准', () => {
    const c = withClock(1000)
    c.metrics.markFirstFrame()
    expect(c.metrics.report().firstFrameCost).toBeNull()
  })

  it('【关键】进入 playing 后，进行中的时段实时计入，且随时间继续增长', () => {
    const c = withClock(1000)
    c.metrics.reset()
    c.advance(200)
    c.metrics.onTransition('playing')
    c.advance(500)
    expect(c.metrics.report().watchTime).toBe(500)
    c.advance(500)
    expect(c.metrics.report().watchTime).toBe(1000) // 同一段仍在进行中
  })

  it('离开 playing 后立即结算，此后不再增长', () => {
    const c = withClock(1000)
    c.metrics.reset()
    c.advance(100)
    c.metrics.onTransition('playing')
    c.advance(500)
    c.metrics.onTransition('paused') // 结算 500ms
    c.advance(5000)
    expect(c.metrics.report().watchTime).toBe(500)
  })

  it('【关键回归】离开路径统一结算：stalled → error（而非 RECOVERED）也照样结算', () => {
    // 这是原始设计的要点：卡顿并不总以 RECOVERED 结束，期间可能迁到 error / ended / paused。
    // 早期只在 RECOVERED 里累加，漏掉其他离开路径 → 那段时长永久少计且很难被发现。
    const c = withClock(1000)
    c.metrics.reset()
    for (const leaveAs of ['error', 'paused', 'ended'] as const) {
      c.metrics.onTransition('playing')
      c.advance(100)
      c.metrics.onTransition('stalled')
      c.advance(300)
      c.metrics.onTransition(leaveAs)
    }
    const r = c.metrics.report()
    expect(r.watchTime).toBe(300) // 3 × 100ms
    expect(r.stallDuration).toBe(900) // 3 × 300ms
    expect(r.stallCount).toBe(3)
  })

  it('卡顿次数按「进入 stalled」计；进行中的卡顿实时计入', () => {
    const c = withClock(1000)
    c.metrics.reset()
    c.metrics.onTransition('playing')
    c.metrics.onTransition('stalled')
    c.advance(250)
    c.metrics.onTransition('stalled') // 再次进入：结算上一段后重新起记
    c.advance(250)
    const r = c.metrics.report()
    expect(r.stallCount).toBe(2)
    expect(r.stallDuration).toBe(500) // 250 已结算 + 250 进行中
  })

  it('reset() 直接清零、**不先结算**：旧会话进行中的尾巴被丢弃', () => {
    const c = withClock(1000)
    c.metrics.reset()
    c.metrics.onTransition('playing')
    c.advance(500)
    c.metrics.reset() // 未结算即清零
    c.advance(100)
    expect(c.metrics.report().watchTime).toBe(0)
    expect(c.metrics.report().stallCount).toBe(0)
  })

  it('重复 reset() 更新起播时刻并清掉首帧耗时', () => {
    const c = withClock(1000)
    c.metrics.reset()
    c.set(1200)
    c.metrics.markFirstFrame()
    expect(c.metrics.report().firstFrameCost).toBe(200)
    c.set(5000)
    c.metrics.reset()
    expect(c.metrics.report().loadStartTime).toBe(5000)
    expect(c.metrics.report().firstFrameCost).toBeNull()
  })

  it('每次调用只读一次时钟（onTransition 内两个结算共用同一时刻）', () => {
    const c = withClock(1000)
    c.metrics.reset() // 1 次
    const afterReset = c.clockCalls
    c.metrics.onTransition('playing') // 1 次
    expect(c.clockCalls).toBe(afterReset + 1)
    c.metrics.onTransition('stalled') // 1 次
    expect(c.clockCalls).toBe(afterReset + 2)
    c.metrics.report() // 1 次
    expect(c.clockCalls).toBe(afterReset + 3)
  })
})
