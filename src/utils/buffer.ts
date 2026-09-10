import type { BufferInfo } from '../types'

/** 从 TimeRanges 读取为 [start, end][] 数组（部分环境 TimeRanges 不可枚举，需按下标读） */
export function readBuffers(ranges: TimeRanges | undefined): [number, number][] {
  const out: [number, number][] = []
  if (!ranges) return out
  for (let i = 0; i < ranges.length; i++) {
    out.push([ranges.start(i), ranges.end(i)])
  }
  return out
}

/**
 * 计算缓冲多口径指标（§1.4 / 类型 BufferInfo 注释）。
 *
 * 单口径（只看最后一块）在 buffer 出现孤岛时会产生误导：
 * 例如 buffers=[[0,10],[30,40]]、currentTime=5，「最后一块」= [30,40]，
 * 会误报 remaining=35，而当前播放点实际只缓冲到 10（真实可播 5s）。
 *
 * 本函数按「播放点所在块」与「全量并集」两个口径分别计算：
 * - 当前块：包含 currentTime 的区间；若该点落在空洞里，退化为其后最近的区间，
 *   再退化为最后一块（保证单调可用，不返回 0 造成误判）。
 * - 总量：所有区间求和（跨孤岛的总囤积，供「缓冲是否足够」判断）。
 */
export function analyzeBuffer(buffers: [number, number][], currentTime: number): Omit<BufferInfo, 'behind'> {
  const totalLength = buffers.reduce((sum, [s, e]) => sum + Math.max(0, e - s), 0)
  const totalRemaining = buffers.reduce((sum, [s, e]) => sum + Math.max(0, e - Math.max(s, currentTime)), 0)

  // 定位当前播放点所在的连续区间
  let current: [number, number] | undefined
  for (const range of buffers) {
    if (currentTime >= range[0] && currentTime <= range[1]) {
      current = range
      break
    }
  }
  if (!current) {
    // 播放点落在空洞：取其后最近的区间（即将播放的下一块）
    current = buffers.find(([s]) => s > currentTime)
  }
  if (!current) {
    // 无后继（已播放到末尾之后）：退化为最后一块，保证 length/remaining 语义可解释
    current = buffers[buffers.length - 1]
  }

  const length = current ? Math.max(0, current[1] - current[0]) : 0
  const remaining = current ? Math.max(0, current[1] - currentTime) : 0

  return { buffers, remaining, length, totalRemaining, totalLength }
}
