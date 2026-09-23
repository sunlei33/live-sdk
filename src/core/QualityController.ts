import type { FeatureKey, LevelInfo, Quality, SideState } from '../types'
import { MSG } from '../constants'
import { logger } from '../utils/logger'
import { t } from '../utils/i18n'

/** 映射表（内部类型，原 `utils/quality.ts` 的 `QualityTable`） */
interface QualityTable {
  /** business id → level index */
  map: Map<number, number>
  /** 映射成功的档位（保持业务传入顺序） */
  valid: Quality[]
  /** 映射失败、应被剔除的档位（调用方负责告警，本模块不产生副作用） */
  dropped: Quality[]
}

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
 *
 * ── 映射规则为什么在本文件，而不是 `utils/` 或 `kernel/` ──
 *
 * `matchQuality` / `buildQualityTable` 原先在 `utils/quality.ts`，其**唯一消费者就是本类**，
 * 故并入（少一个「只有一个消费者」的模块）。而两条判据说明它们**不能**下沉到 `kernel/`：
 * ① 内核对「业务档位 id」（`Quality.id`）**没有概念** —— 它只认 level index / height / bitrate，
 *    放进去等于把业务概念泄漏进内核契约；
 * ② 内核是**可替换契约**（`config.kernel`，支持自研内核），而 `NativeKernel` 连 `getLevels()`
 *    都不实现 —— 映射挂在核心里会要求每个内核实现重复它，且在原生回退路径上无处安放。
 * （另有机械约束：`verify/layers.mjs` 的矩阵里 `core` 不得依赖 `kernel`，故 core 持有的映射
 * 一旦放进内核，分层门会直接失败。）
 *
 * ⚠️ 并入**不等于**放松测试：原 `test/quality.test.ts` 的 10 条边界用例已并入
 * `test/QualityController.test.ts`，改为经 `syncLevels` / `levelIndexOf` 断言 ——
 * 覆盖的是同一批分支（height 命中 / 命中优先于 bitrate / 最近邻兜底 / 都不命中 / 空 levels /
 * 重复 bitrate / 入参不被修改），只是入口从「纯函数」换成了「持有着的公开行为」。
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
   *
   * 注意与「映射失败」的区别：`levels` 为空是**内核不支持清晰度**，不是映射失败，
   * 故走特判、**不逐条告警**。
   */
  syncLevels(business: Quality[], levels: LevelInfo[]): Quality[] {
    if (levels.length === 0) {
      this.map = new Map()
      return []
    }
    const { map, valid, dropped } = this.buildQualityTable(business, levels)
    this.map = map
    for (const q of dropped) logger.warn(`[live-sdk] ${t(MSG.QUALITY_MAPPING_DROPPED, { id: q.id })}`)
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

  // ═══════════ 以下两项原先在 utils/quality.ts（唯一消费者就是本类，故并入）═══════════

  /**
   * 业务档位 → 内核 level index 的映射（**纯计算**，不依赖实例状态）。
   *
   * ── 为什么用「双键兜底」而不是只用 height ──
   *
   * 业务侧给的是**自定义档位标识**（`Quality.id`），与 master m3u8 里的 `RESOLUTION`/`BANDWIDTH`
   * 完全解耦（见 spec §4.3）。因此需要两层映射：
   * 1. `height` 精确命中（主键）—— 最可靠，业务通常按分辨率定义档位；
   * 2. `bitrate` 最近邻（兜底）—— 服务端换了转码模板、分辨率高度对不上时还能挂上档位；
   * 3. 都不命中 → `-1`，由调用方剔除并告警（**不猜**，猜错会让用户切到非预期档位）。
   */
  private matchQuality(q: Quality, levels: LevelInfo[]): number {
    if (q.height != null) {
      const hit = levels.find((l) => l.height === q.height)
      if (hit) return hit.index
    }
    if (q.bitrate != null) {
      let best = -1
      let bestDiff = Infinity
      for (const l of levels) {
        const d = Math.abs(l.bitrate - q.bitrate)
        if (d < bestDiff) {
          bestDiff = d
          best = l.index
        }
      }
      return best
    }
    return -1
  }

  /** 为一组业务档位建映射表。`levels` 为空时由调用方直接跳过（见 `syncLevels` 的特判）。 */
  private buildQualityTable(business: Quality[], levels: LevelInfo[]): QualityTable {
    const map = new Map<number, number>()
    const valid: Quality[] = []
    const dropped: Quality[] = []
    for (const q of business) {
      const idx = this.matchQuality(q, levels)
      if (idx >= 0) {
        map.set(q.id, idx)
        valid.push(q)
      } else {
        dropped.push(q)
      }
    }
    return { map, valid, dropped }
  }
}
