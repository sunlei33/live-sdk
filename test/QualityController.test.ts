import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { QualityController } from '../src/core/QualityController'
import { logger } from '../src/utils/logger'
import type { LevelInfo } from '../src/types'

const L = (index: number, height: number, bitrate: number): LevelInfo => ({ index, height, bitrate })
const LEVELS = [L(0, 360, 400_000), L(1, 720, 1_800_000)]

/**
 * `QualityController` 单测：**不需要 Player、不需要内核、不需要 DOM**。
 *
 * 它只持有「随内核/清单重建」的派生数据 + 纯计算，不产生副作用 ——
 * 这正是把它从 `Player` 抽出来的收益（此前这段逻辑完全测不到）。
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
