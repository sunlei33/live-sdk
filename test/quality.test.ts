import { describe, it, expect } from 'vitest'
import { matchQuality, buildQualityTable } from '../src/utils/quality'
import type { LevelInfo, Quality } from '../src/types'

const L = (index: number, height: number, bitrate: number): LevelInfo => ({ index, height, bitrate })
const LEVELS = [L(0, 360, 400_000), L(1, 540, 900_000), L(2, 720, 1_800_000), L(3, 1080, 4_000_000)]

describe('matchQuality：业务档位 → 内核 level index', () => {
  it('height 精确命中（主键）', () => {
    expect(matchQuality({ id: 1, height: 720 }, LEVELS)).toBe(2)
    expect(matchQuality({ id: 2, height: 360 }, LEVELS)).toBe(0)
  })

  it('【关键】height 命中优先于 bitrate —— 两者都给时以 height 为准', () => {
    // 若以 bitrate 为准，下面这条会落到 index 3（4Mbps 最近），但我们要求 height 赢
    expect(matchQuality({ id: 1, height: 540, bitrate: 4_000_000 }, LEVELS)).toBe(1)
  })

  it('height 对不上时用 bitrate 最近邻兜底（服务端换转码模板的场景）', () => {
    expect(matchQuality({ id: 1, height: 999, bitrate: 950_000 }, LEVELS)).toBe(1) // 最接近 900k
    expect(matchQuality({ id: 2, bitrate: 3_900_000 }, LEVELS)).toBe(3)
    expect(matchQuality({ id: 3, bitrate: 1 }, LEVELS)).toBe(0) // 极小值 → 最低档
  })

  it('两个键都没给 → -1（不猜）', () => {
    expect(matchQuality({ id: 1 }, LEVELS)).toBe(-1)
  })

  it('给了键但一个都对不上 → -1', () => {
    expect(matchQuality({ id: 1, height: 4320 }, [])).toBe(-1)
  })

  it('bitrate 相等时取先出现的那个（稳定，不受遍历顺序影响）', () => {
    const dup = [L(0, 360, 500_000), L(1, 360, 500_000)]
    expect(matchQuality({ id: 1, bitrate: 500_000 }, dup)).toBe(0)
  })
})

describe('buildQualityTable：整表构建与剔除', () => {
  const business: Quality[] = [
    { id: 10, height: 360 },
    { id: 11, height: 720 },
    { id: 12, height: 4320 }, // 映射失败 → dropped
    { id: 13, bitrate: 4_000_000 },
  ]

  it('有效档位保持业务传入顺序，失败档位进 dropped', () => {
    const { valid, dropped, map } = buildQualityTable(business, LEVELS)
    expect(valid.map((q) => q.id)).toEqual([10, 11, 13])
    expect(dropped.map((q) => q.id)).toEqual([12])
    expect([...map.entries()]).toEqual([
      [10, 0],
      [11, 2],
      [13, 3],
    ])
  })

  it('业务档位为空 → 空表（不抛错）', () => {
    const { valid, dropped, map } = buildQualityTable([], LEVELS)
    expect(valid).toEqual([])
    expect(dropped).toEqual([])
    expect(map.size).toBe(0)
  })

  it('level 列表为空 → 全部落 dropped', () => {
    const { valid, dropped } = buildQualityTable(business, [])
    expect(valid).toEqual([])
    expect(dropped.length).toBe(business.length)
  })

  it('【契约】纯函数不产生副作用：不修改入参', () => {
    const snapshot = JSON.stringify(business)
    buildQualityTable(business, LEVELS)
    expect(JSON.stringify(business)).toBe(snapshot)
  })
})
