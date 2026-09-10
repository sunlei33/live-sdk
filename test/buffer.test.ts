import { describe, it, expect } from 'vitest'
import { analyzeBuffer, readBuffers } from '../src/utils/buffer'

/** 构造 TimeRanges 替身 */
function ranges(pairs: Array<[number, number]>): TimeRanges {
  return {
    length: pairs.length,
    start: (i: number) => pairs[i][0],
    end: (i: number) => pairs[i][1],
  } as unknown as TimeRanges
}

describe('readBuffers', () => {
  it('读取空 TimeRanges → []', () => {
    expect(readBuffers(ranges([]))).toEqual([])
  })

  it('读取多区间', () => {
    expect(readBuffers(ranges([[0, 10], [30, 40]]))).toEqual([[0, 10], [30, 40]])
  })

  it('undefined → []（不抛错）', () => {
    expect(readBuffers(undefined)).toEqual([])
  })
})

describe('analyzeBuffer 多口径（buffer 孤岛场景）', () => {
  it('单区间：当前块口径 = 总量口径', () => {
    const r = analyzeBuffer([[0, 10]], 5)
    expect(r.remaining).toBe(5)
    expect(r.length).toBe(10)
    expect(r.totalRemaining).toBe(5)
    expect(r.totalLength).toBe(10)
  })

  it('孤岛：remaining 取当前播放块，不取最后一块（核心修复点）', () => {
    // buffers=[[0,10],[30,40]]，播放点在 5
    // 旧实现（取最后一块）= 40-5 = 35（错误，播放点根本不在第二块里）
    // 新实现（取当前块）= 10-5 = 5（正确）
    const r = analyzeBuffer([[0, 10], [30, 40]], 5)
    expect(r.remaining).toBe(5)
    expect(r.length).toBe(10)
  })

  it('孤岛：totalRemaining 跨孤岛求和', () => {
    const r = analyzeBuffer([[0, 10], [30, 40]], 5)
    // 到 10 剩 5，到 40 剩 10 → 15
    expect(r.totalRemaining).toBe(15)
    expect(r.totalLength).toBe(20)
  })

  it('播放点落在空洞：退化为其后最近的区间', () => {
    // buffers=[[0,10],[30,40]]，播放点在 20（空洞中）
    // 退化为其后最近区间 [30,40] 作为「当前块」，remaining 仍相对 currentTime 计算
    const r = analyzeBuffer([[0, 10], [30, 40]], 20)
    expect(r.remaining).toBe(20) // 40 - 20 = 20
    expect(r.length).toBe(10) // 区间长度
  })

  it('播放点超过所有区间：退化为最后一块（不返回 0 造成误判）', () => {
    const r = analyzeBuffer([[0, 10], [30, 40]], 50)
    expect(r.length).toBe(10)
    expect(r.remaining).toBe(0) // 已播过末尾，剩余为 0 是合理的
  })

  it('空缓冲：全为 0', () => {
    const r = analyzeBuffer([], 5)
    expect(r.remaining).toBe(0)
    expect(r.length).toBe(0)
    expect(r.totalRemaining).toBe(0)
    expect(r.totalLength).toBe(0)
  })

  it('buffers 原样保留（不裁剪）', () => {
    const bufs: Array<[number, number]> = [[0, 10], [30, 40]]
    expect(analyzeBuffer(bufs, 5).buffers).toBe(bufs)
  })
})

describe('analyzeBuffer 边界：currentTime 在各区间端点', () => {
  it('currentTime 恰在区间起点', () => {
    const r = analyzeBuffer([[30, 40]], 30)
    expect(r.remaining).toBe(10)
  })

  it('currentTime 恰在区间终点', () => {
    const r = analyzeBuffer([[30, 40]], 40)
    expect(r.remaining).toBe(0)
  })

  it('多区间重叠时按首个匹配区间计算', () => {
    const r = analyzeBuffer([[0, 20], [10, 30]], 15)
    expect(r.length).toBe(20) // 取第一个包含点位的区间
  })
})
