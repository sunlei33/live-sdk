import { ERROR_CODE } from '../constants'

/**
 * 内核错误 → SDK 错误码映射。
 *
 * ⚠️ 必须**不区分大小写**：各内核的 details 命名风格不同 ——
 * hls.js 用 camelCase（`manifestLoadError` / `fragLoadError` / `networkError`），
 * 自研内核可能用全大写常量（`MANIFEST_LOAD_ERROR`）。若只匹配大写，
 * hls.js 的错误会**全部落到 UNKNOWN**，直接打穿「接口与 CDN 异常可观测」。
 *
 * 关键词覆盖（子串匹配，已统一大写）：
 * | 命中关键词 | 错误码 | 典型来源 |
 * |---|---|---|
 * | MANIFEST + 404/HTTP 404 | `manifest_404` | 主 playlist 不存在 |
 * | MANIFEST | `manifest_load_error` | 主 playlist 拉取/解析失败 |
 * | FRAG | `frag_load_error` | 分片加载失败 |
 * | NETWORK | `network_error` | 网络类错误（type=networkError） |
 * | 其余 | `unknown` | 未归类 |
 *
 * @param details  内核错误详情（hls.js 的 `data.details` 或自研内核等价字段）
 * @param httpStatus 可选：本次失败的 HTTP 状态码（hls.js 放在 `data.response.code`，不在 details 里，
 *                   因此仅靠 details 无法识别 404，必须显式传入）
 */
export function mapErrorCode(details: string, httpStatus?: number): string {
  const d = (details ?? '').toUpperCase()
  const is404 = httpStatus === 404 || d.includes('404')
  if (d.includes('MANIFEST')) {
    return is404 ? ERROR_CODE.MANIFEST_404 : ERROR_CODE.MANIFEST_LOAD_ERROR
  }
  if (d.includes('FRAG')) return ERROR_CODE.FRAG_LOAD_ERROR
  if (d.includes('NETWORK')) return ERROR_CODE.NETWORK_ERROR
  return ERROR_CODE.UNKNOWN
}

/**
 * 判定内核错误是否 fatal（SDK 尽力后仍不可用，需接入方介入）。
 *
 * 同样**不区分大小写**——原实现用大写关键词匹配 hls.js 的小写 details，恒为 false，
 * 会把致命错误误判成可恢复、进而走无意义的重连。
 *
 * 注意：`mediaError` 是 hls.js 的 **ErrorTypes.type**（非 details），值本身就是小写，
 * 这里按「忽略大小写」一并处理，避免调用方混淆 type/details 时漏判。
 */
export function isFatalKernelError(details: string, type: string | undefined, kernelFatal: boolean): boolean {
  if (!kernelFatal) return false
  const d = (details ?? '').toUpperCase()
  if (d.includes('MANIFEST') || d.includes('CODEC') || d.includes('KEY')) return true
  return (type ?? '').toLowerCase() === 'mediaerror'
}
