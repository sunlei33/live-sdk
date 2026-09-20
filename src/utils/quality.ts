import type { LevelInfo, Quality } from '../types'

/**
 * 业务档位 → 内核 level index 的映射（**纯函数**，无需 Player / 内核 / DOM）。
 *
 * 抽出来的理由与 `utils/features.ts`（`matchFeature`）同源：这类「映射 + 对齐」逻辑分支多、
 * 边界情况集中（height 命中 / bitrate 最近邻 / 都不命中），留在 `Player` 里等于没有单测覆盖。
 *
 * ── 为什么用「双键兜底」而不是只用 height ──
 *
 * 业务侧给的是**自定义档位标识**（`Quality.id`），与 master m3u8 里的 `RESOLUTION`/`BANDWIDTH`
 * 完全解耦（见 spec §4.3）。因此需要两层映射：
 * 1. `height` 精确命中（主键）—— 最可靠，业务通常按分辨率定义档位；
 * 2. `bitrate` 最近邻（兜底）—— 服务端换了转码模板、分辨率高度对不上时还能挂上档位；
 * 3. 都不命中 → `-1`，由调用方剔除并告警（**不猜**，猜错会让用户切到非预期档位）。
 */
export function matchQuality(q: Quality, levels: LevelInfo[]): number {
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

export interface QualityTable {
  /** business id → level index */
  map: Map<number, number>
  /** 映射成功的档位（保持业务传入顺序） */
  valid: Quality[]
  /** 映射失败、应被剔除的档位（调用方负责告警，本模块不产生副作用） */
  dropped: Quality[]
}

/** 为一组业务档位建映射表。`levels` 为空时由调用方直接跳过（本函数不特判）。 */
export function buildQualityTable(business: Quality[], levels: LevelInfo[]): QualityTable {
  const map = new Map<number, number>()
  const valid: Quality[] = []
  const dropped: Quality[] = []
  for (const q of business) {
    const idx = matchQuality(q, levels)
    if (idx >= 0) {
      map.set(q.id, idx)
      valid.push(q)
    } else {
      dropped.push(q)
    }
  }
  return { map, valid, dropped }
}
