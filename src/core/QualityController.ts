import type { FeatureKey, LevelInfo, Quality, SideState } from '../types'
import { buildQualityTable } from '../utils/quality'
import { logger } from '../utils/logger'
import { bi } from '../utils/i18n'

/**
 * 清晰度映射与服务端能力声明的**派生状态持有者**（spec §4.3 / §4.7）。
 *
 * ── 为什么从 `Player` 抽出来 ──
 *
 * `qualityMap` 与 `serverFeatures` 都是**「随内核/清单变化而重建」的派生数据**：
 * 前者在内核 `levels_updated` / `manifest_parsed` 时重建，后者在清单解析后重建。
 * 它们自带失效与重建的时机，但**不需要整台播放器** —— 字段—方法引用矩阵里两个字段各只有
 * 2~4 个方法引用，属于典型的「孤岛状态簇」。
 *
 * ── 职责边界（有意如此）──
 *
 * 本类**只持有派生数据 + 纯计算**，不产生副作用：不写状态快照、不派发事件、不碰内核。
 * 因此它可以脱离 `Player` / DOM / 内核单测。所有副作用（`state.set`、`emit(QUALITY_CHANGE)`
 * 等）仍留在 `Player` 的命令与查询里 —— 这也是本类叫 Controller 而非 Manager 的原因：
 * 它描述「当前有哪些档位、映射到哪」，不负责「切档怎么做」。
 */
export class QualityController {
  /** business id → level index */
  private map = new Map<number, number>()

  /**
   * 服务端能力声明（由清单推导，见 `probeServer`）。
   *
   * `airplay` 初值即 `supported`：它是纯客户端/平台能力，**不依赖服务端 manifest**，
   * 因此服务端侧无条件满足。不能填 `'unknown'` —— 那会被误读成「尚未探测」，
   * 从而在端到端对齐的 `matched` 口径里留下无意义的未对齐态（曾是一个真实 bug 的根因）。
   */
  private server: Record<FeatureKey, SideState> = {
    lowLatency: 'unknown',
    abr: 'unknown',
    qualitySwitch: 'unknown',
    drm: 'unknown',
    airplay: 'supported',
  }

  /**
   * 依据当前内核 level 列表重建映射表，返回**有效档位**（保持业务传入顺序）。
   *
   * `levels` 为空（内核不支持清晰度 / 清单尚未解析）时清空映射并返回空数组 ——
   * 调用方据此把快照写成「无档位」，UI 会隐藏清晰度面板（见 `ui/controls.ts`）。
   * 映射失败的档位在此**告警并剔除**：不猜，猜错会让用户切到非预期档位。
   */
  syncLevels(business: Quality[], levels: LevelInfo[]): Quality[] {
    if (levels.length === 0) {
      this.map = new Map()
      return []
    }
    const { map, valid, dropped } = buildQualityTable(business, levels)
    this.map = map
    for (const q of dropped) logger.warn(`[live-sdk] ${bi(`档位映射失败，已剔除：id=${q.id}`, `quality mapping failed, dropped: id=${q.id}`)}`)
    return valid
  }

  /** 业务档位 id → 内核 level index；未映射（或已失效）返回 `undefined`。 */
  levelIndexOf(id: number): number | undefined {
    return this.map.get(id)
  }

  /**
   * 由清单数据推导服务端能力声明（spec §4.7）。
   *
   * 只认两件事：`hasLL`（清单是否声明低延迟）与 `levelCount > 1`（是否多档 → ABR/清晰度可用）。
   * `drm` 恒 `absent`（§1.3 已划出范围）。
   *
   * @param data 内核 `manifest_parsed` 的原始载荷（结构未收敛，故按需读取）
   * @param levelCount 当前内核 level 数量（由调用方从内核读取后传入）
   */
  probeServer(data: unknown, levelCount: number): void {
    const hasLL = (data as { hasLL?: boolean } | undefined)?.hasLL === true
    const multi = levelCount > 1
    this.server = {
      lowLatency: hasLL ? 'supported' : 'absent',
      abr: multi ? 'supported' : 'absent',
      qualitySwitch: multi ? 'supported' : 'absent',
      drm: 'absent',
      airplay: 'supported',
    }
  }

  /** 读服务端侧能力状态（供端到端对齐报告 `getFeatureStatus()` 使用）。 */
  serverState(feature: FeatureKey): SideState {
    return this.server[feature]
  }
}
