import type { FeatureKey, FeatureStatus, SideState } from '../types'
import { bi } from './i18n'

/** 客户端侧能力是否「可用」：supported=SDK 原生支持；degraded=平台接管仍可用（如原生回退投屏） */
export function isClientUsable(state: SideState): boolean {
  return state === 'supported' || state === 'degraded'
}

/** 服务端侧是否「可用」：只有 supported 算满足；absent=上游没提供；unknown=尚未探测（不算可用） */
export function isServerUsable(state: SideState): boolean {
  return state === 'supported'
}

/**
 * 计算单条特性的端到端对齐结果（§4.7）。
 *
 * `matched` 统一口径 = 客户端可用 **且** 服务端可用。不再为 `airplay` 开特例——
 * 它「无服务端依赖」这件事，改由 `server` 恒为 `supported` 来表达（见 probeServerFeatures），
 * 而非在匹配逻辑里绕过服务端判据（旧实现的 bug：server=unknown 却 matched=true）。
 */
export function matchFeature(
  feature: FeatureKey,
  client: SideState,
  server: SideState,
): FeatureStatus {
  const clientUsable = isClientUsable(client)
  const serverUsable = isServerUsable(server)
  const matched = clientUsable && serverUsable

  let detail: string | undefined
  if (!matched) {
    detail = !clientUsable ? bi('客户端不支持', 'unsupported by the client') : !serverUsable ? bi('服务端未提供', 'not provided by the server') : bi('端到端未对齐', 'end-to-end mismatch')
  } else if (client === 'degraded') {
    detail = bi('原生回退路径，投屏由系统接管', 'native fallback path; casting is handled by the system')
  }
  return { feature, client, server, matched, detail }
}
