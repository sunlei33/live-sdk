import { describe, it, expect, vi } from 'vitest'
import {
  shouldDedupError,
  computeRetryDelay,
  ERROR_DEDUP_WINDOW_MS,
  type DedupState,
} from '../src/utils/retry'

/** 造一个干净的去重状态 */
function freshState(): DedupState {
  return { code: '', time: 0 }
}

describe('shouldDedupError：防重试风暴（10s 窗口）', () => {
  it('首次出现的错误 → 放行', () => {
    expect(shouldDedupError(freshState(), { code: 'NETWORK_ERROR' }, 1000)).toBe(false)
  })

  it('窗口内同类错误 → 抑制', () => {
    const s = freshState()
    shouldDedupError(s, { code: 'NETWORK_ERROR' }, 1000)
    expect(shouldDedupError(s, { code: 'NETWORK_ERROR' }, 1000 + 1)).toBe(true)
  })

  it('窗口内同类错误连续出现 → 只放行第一条', () => {
    const s = freshState()
    const now = 1_000_000
    expect(shouldDedupError(s, { code: 'NETWORK_ERROR' }, now)).toBe(false)
    expect(shouldDedupError(s, { code: 'NETWORK_ERROR' }, now + 1)).toBe(true)
    expect(shouldDedupError(s, { code: 'NETWORK_ERROR' }, now + 9_999)).toBe(true)
  })

  it('恰好超出窗口边界（10_000ms）→ 放行（复发上报）', () => {
    const s = freshState()
    const now = 1_000_000
    shouldDedupError(s, { code: 'NETWORK_ERROR' }, now)
    expect(shouldDedupError(s, { code: 'NETWORK_ERROR' }, now + ERROR_DEDUP_WINDOW_MS)).toBe(false)
  })

  it('不同 code 互相不抑制（故障变了必须放行）', () => {
    const s = freshState()
    const now = 1_000_000
    expect(shouldDedupError(s, { code: 'NETWORK_ERROR' }, now)).toBe(false)
    expect(shouldDedupError(s, { code: 'MANIFEST_LOAD_ERROR' }, now + 1)).toBe(false)
  })

  it('换 code 后原 code 的窗口被重置（以最后一次放行为准）', () => {
    const s = freshState()
    const now = 1_000_000
    shouldDedupError(s, { code: 'A' }, now)
    shouldDedupError(s, { code: 'B' }, now + 5_000) // B 放行，state 变为 B
    // A 再出现：与 state(B) 不同 → 放行，而不是命中旧的 A 窗口
    expect(shouldDedupError(s, { code: 'A' }, now + 6_000)).toBe(false)
  })

  it('抑制时不更新窗口起点（避免无限抑制）', () => {
    const s = freshState()
    const now = 1_000_000
    shouldDedupError(s, { code: 'X' }, now)
    shouldDedupError(s, { code: 'X' }, now + 9_000) // 被抑制，time 不应被刷新
    expect(s.time).toBe(now)
    // 因此 now+10_000 时已超窗 → 放行
    expect(shouldDedupError(s, { code: 'X' }, now + ERROR_DEDUP_WINDOW_MS)).toBe(false)
  })
})

describe('computeRetryDelay：指数退避 + 抖动', () => {
  it('无抖动部分时 = base * 2^(n-1)', () => {
    const noJitter = () => 0
    expect(computeRetryDelay(1000, 1, noJitter)).toBe(1000)
    expect(computeRetryDelay(1000, 2, noJitter)).toBe(2000)
    expect(computeRetryDelay(1000, 3, noJitter)).toBe(4000)
    expect(computeRetryDelay(1000, 4, noJitter)).toBe(8000)
  })

  it('抖动上限为 base（random→1）', () => {
    const maxJitter = () => 1
    expect(computeRetryDelay(1000, 1, maxJitter)).toBe(2000)
    expect(computeRetryDelay(1000, 3, maxJitter)).toBe(5000)
  })

  it('延迟严格落在 [base*2^(n-1), base*2^(n-1) + base) 区间', () => {
    const base = 500
    for (let n = 1; n <= 6; n++) {
      const exp = base * Math.pow(2, n - 1)
      for (let i = 0; i < 50; i++) {
        const d = computeRetryDelay(base, n)
        expect(d).toBeGreaterThanOrEqual(exp)
        expect(d).toBeLessThan(exp + base)
      }
    }
  })

  it('递增性：同抖动比例下后一次不小于前一次', () => {
    const half = () => 0.5
    expect(computeRetryDelay(1000, 2, half)).toBeGreaterThan(computeRetryDelay(1000, 1, half))
    expect(computeRetryDelay(1000, 3, half)).toBeGreaterThan(computeRetryDelay(1000, 2, half))
  })

  it('默认使用 Math.random 且结果有限', () => {
    const spy = vi.spyOn(Math, 'random')
    const d = computeRetryDelay(1000, 1)
    expect(spy).toHaveBeenCalled()
    expect(Number.isFinite(d)).toBe(true)
    spy.mockRestore()
  })
})
