import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { QualityController } from '../src/core/QualityController'
import { logger } from '../src/utils/logger'
import type { LevelInfo, Quality } from '../src/types'

const L = (index: number, height: number, bitrate: number): LevelInfo => ({ index, height, bitrate })
const LEVELS = [L(0, 360, 400_000), L(1, 720, 1_800_000)]
/** 4 档表：给「映射规则」那组用 —— 需要更多档位才能把 height 命中与 bitrate 最近邻区分开 */
const LEVELS4 = [L(0, 360, 400_000), L(1, 540, 900_000), L(2, 720, 1_800_000), L(3, 1080, 4_000_000)]

/**
 * `QualityController` 单测：**不需要 Player、不需要内核、不需要 DOM**。
 *
 * 它只持有「随内核/清单重建」的派生数据 + 纯计算，不产生副作用 ——
 * 这正是把它从 `Player` 抽出来的收益（此前这段逻辑完全测不到）。
 *
 * ⚠️ 映射规则（原来的 `utils/quality.ts`）已并入本类、不再对外导出；它原先那 10 条边界用例
 * 也跟着挪到下面第二个 describe，**入口从「纯函数」换成「持有着的公开行为」**
 * （`syncLevels` + `levelIndexOf`），覆盖的是同一批分支，没有因为搬家而减少覆盖。
 */
describe('QualityController：档位映射表的建立、失效与查询', () => {
  let c: QualityController
  beforeEach(() => {
    c = new QualityController()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('syncLevels 建表并返回有效档位；levelIndexOf 可查', () => {
    const valid = c.syncLevels([{ id: 1, height: 720 }, { id: 2, height: 360 }], LEVELS)
    expect(valid.map((q) => q.id)).toEqual([1, 2])
    expect(c.levelIndexOf(1)).toBe(1)
    expect(c.levelIndexOf(2)).toBe(0)
  })

  it('未映射的 id 返回 undefined（调用方据此判 applied=false）', () => {
    c.syncLevels([{ id: 1, height: 720 }], LEVELS)
    expect(c.levelIndexOf(999)).toBeUndefined()
  })

  it('映射失败的档位被剔除并告警', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const valid = c.syncLevels([{ id: 1, height: 720 }, { id: 2, height: 4320 }], LEVELS)
    expect(valid.map((q) => q.id)).toEqual([1])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('id=2')
  })

  it('【关键】levels 为空 → 清空映射（旧映射不得残留）', () => {
    c.syncLevels([{ id: 1, height: 720 }], LEVELS)
    expect(c.levelIndexOf(1)).toBe(1)

    const valid = c.syncLevels([{ id: 1, height: 720 }], []) // 内核不支持清晰度 / 清单换了
    expect(valid).toEqual([])
    expect(c.levelIndexOf(1)).toBeUndefined() // ← 残留会让切档打到已失效的 level
  })

  it('再次 syncLevels 整体替换（不是合并）', () => {
    c.syncLevels([{ id: 1, height: 720 }, { id: 2, height: 360 }], LEVELS)
    c.syncLevels([{ id: 2, height: 360 }], LEVELS)
    expect(c.levelIndexOf(1)).toBeUndefined()
    expect(c.levelIndexOf(2)).toBe(0)
  })

  it('probeServer：多档 → abr / qualitySwitch 为 supported，drm 恒 absent', () => {
    c.probeServer({}, 2)
    expect(c.serverState('abr')).toBe('supported')
    expect(c.serverState('qualitySwitch')).toBe('supported')
    expect(c.serverState('lowLatency')).toBe('absent') // 未声明 hasLL
    expect(c.serverState('drm')).toBe('absent')
  })

  it('probeServer：单档 → abr / qualitySwitch 为 absent；hasLL 决定 lowLatency', () => {
    c.probeServer({ hasLL: true }, 1)
    expect(c.serverState('lowLatency')).toBe('supported')
    expect(c.serverState('abr')).toBe('absent')
    expect(c.serverState('qualitySwitch')).toBe('absent')
  })

  it('【回归】airplay 服务端侧恒 supported —— 初值与探测后都不受 manifest 影响', () => {
    // 它是纯客户端/平台能力。曾把它写成 'unknown'，被误读为「尚未探测」，
    // 污染端到端对齐的 matched 口径（真实 bug 的根因）。
    expect(c.serverState('airplay')).toBe('supported')
    c.probeServer(undefined, 3)
    expect(c.serverState('airplay')).toBe('supported')
    c.probeServer({ hasLL: false }, 0)
    expect(c.serverState('airplay')).toBe('supported')
  })

  it('probeServer 可被重复调用（每次清单解析都重建）', () => {
    c.probeServer({ hasLL: true }, 3)
    expect(c.serverState('lowLatency')).toBe('supported')
    c.probeServer({}, 1)
    expect(c.serverState('lowLatency')).toBe('absent')
  })

  it('probeServer 容忍 undefined / 畸形载荷（内核透传的原始数据不可信）', () => {
    expect(() => c.probeServer(undefined, 0)).not.toThrow()
    expect(() => c.probeServer('not-an-object', 2)).not.toThrow()
    expect(() => c.probeServer({ hasLL: 'yes' as unknown as boolean }, 2)).not.toThrow()
    expect(c.serverState('lowLatency')).toBe('absent') // 非布尔 true 一律按未声明
  })
})

describe('QualityController：映射规则的分支（原 test/quality.test.ts 并入）', () => {
  let c: QualityController
  beforeEach(() => {
    c = new QualityController()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 建表后查「某个业务 id 落到哪个 level index」—— 等价于原 `matchQuality` 的返回值 */
  const at = (q: Quality, levels: LevelInfo[]) => {
    c.syncLevels([q], levels)
    return c.levelIndexOf(q.id)
  }

  it('height 精确命中（主键）', () => {
    expect(at({ id: 1, height: 720 }, LEVELS4)).toBe(2)
    expect(at({ id: 2, height: 360 }, LEVELS4)).toBe(0)
  })

  it('【关键】height 命中优先于 bitrate —— 两者都给时以 height 为准', () => {
    // 若以 bitrate 为准，下面这条会落到 index 3（4Mbps 最近），但我们要求 height 赢
    expect(at({ id: 1, height: 540, bitrate: 4_000_000 }, LEVELS4)).toBe(1)
  })

  it('height 对不上时用 bitrate 最近邻兜底（服务端换转码模板的场景）', () => {
    expect(at({ id: 1, height: 999, bitrate: 950_000 }, LEVELS4)).toBe(1) // 最接近 900k
    expect(at({ id: 2, bitrate: 3_900_000 }, LEVELS4)).toBe(3)
    expect(at({ id: 3, bitrate: 1 }, LEVELS4)).toBe(0) // 极小值 → 最低档
  })

  it('两个键都没给 → 剔除（不猜），且逐条告警', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    expect(at({ id: 1 }, LEVELS4)).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('id=1')
  })

  it('给了键但一个都对不上 → 剔除', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    expect(at({ id: 1, height: 4320 }, LEVELS4)).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('bitrate 相等时取先出现的那个（稳定，不受遍历顺序影响）', () => {
    const dup = [L(0, 360, 500_000), L(1, 360, 500_000)]
    expect(at({ id: 1, bitrate: 500_000 }, dup)).toBe(0)
  })

  it('有效档位保持业务传入顺序，失败档位被剔除并告警', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const business: Quality[] = [
      { id: 10, height: 360 },
      { id: 11, height: 720 },
      { id: 12, height: 4320 }, // 映射失败 → 剔除
      { id: 13, bitrate: 4_000_000 },
    ]
    const valid = c.syncLevels(business, LEVELS4)
    expect(valid.map((q) => q.id)).toEqual([10, 11, 13])
    expect(c.levelIndexOf(10)).toBe(0)
    expect(c.levelIndexOf(11)).toBe(2)
    expect(c.levelIndexOf(13)).toBe(3)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('id=12')
  })

  it('业务档位为空 → 空表（不抛错、不告警）', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    expect(c.syncLevels([], LEVELS4)).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('内核 level 列表为空 → 全清，且**不逐条告警**（那是「不支持清晰度」，不是映射失败）', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    expect(c.syncLevels([{ id: 1, height: 720 }], [])).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('【契约】不产生副作用：入参（业务档位与 level 列表）都不被修改', () => {
    const business: Quality[] = [{ id: 1, height: 720 }]
    const levels = [...LEVELS4]
    const snapB = JSON.stringify(business)
    const snapL = JSON.stringify(levels)
    c.syncLevels(business, levels)
    expect(JSON.stringify(business)).toBe(snapB)
    expect(JSON.stringify(levels)).toBe(snapL)
  })
})
