import { ERROR_CODE, ERROR_DOMAIN, type ErrorDomain } from '../constants'

/**
 * 错误码 → 错误域（`ERROR_CODE` 到「该去哪儿排查」的收敛层，见 `ERROR_DOMAIN` 的说明）。
 *
 * 映射原则：**按「谁能修」划分**，而不是按「哪行代码报的」——
 * - `network` → 服务端 / CDN / 链路侧可修；
 * - `decode` → 内容 / 转码侧可修（含 DRM：加密是流的属性）；
 * - `config` → 接入方自己可修（配置、平台能力、自动播放策略）。
 *
 * ⚠️ **新增 `ERROR_CODE` 时必须同步本表**，否则会落到 `unknown`。
 * `test/errors.test.ts` 有一条断言遍历 `ERROR_CODE` 全量值，漏了会失败。
 */
const DOMAIN_BY_CODE: Record<string, ErrorDomain> = {
  // —— 服务端 / CDN / 链路 ——
  [ERROR_CODE.MANIFEST_LOAD_ERROR]: ERROR_DOMAIN.NETWORK,
  [ERROR_CODE.MANIFEST_404]: ERROR_DOMAIN.NETWORK,
  [ERROR_CODE.FRAG_LOAD_ERROR]: ERROR_DOMAIN.NETWORK,
  [ERROR_CODE.NETWORK_ERROR]: ERROR_DOMAIN.NETWORK,
  [ERROR_CODE.LOAD_TIMEOUT]: ERROR_DOMAIN.NETWORK,
  // 重连只由「可恢复」错误触发，而可恢复的那几个（manifest/frag/network/timeout）
  // 全是网络域；fatal 的 media_* 不会重试。故重试耗尽必然属网络域。
  [ERROR_CODE.RETRY_EXHAUSTED]: ERROR_DOMAIN.NETWORK,

  // —— 内容 / 转码 / 内核 ——
  [ERROR_CODE.MEDIA_DECODE_ERROR]: ERROR_DOMAIN.DECODE,
  [ERROR_CODE.MEDIA_SRC_NOT_SUPPORTED]: ERROR_DOMAIN.DECODE,
  // DRM 归内容侧：加密是「这条流的属性」，拿不到 license 要回内容/服务端确认，
  // 而不是去查接入配置。接入方若想按能力位前置拦截，应看 getFeatureStatus() 的 drm 项。
  [ERROR_CODE.DRM_NO_LICENSE]: ERROR_DOMAIN.DECODE,

  // —— 接入侧配置 / 平台能力 ——
  [ERROR_CODE.CONFIG_RESOLVE_FAILED]: ERROR_DOMAIN.CONFIG,
  // 无可用内核 = 当前平台能力与配置选路的结果，接入方需要改 kernel 配置或降级策略
  [ERROR_CODE.NO_SUPPORTED_KERNEL]: ERROR_DOMAIN.CONFIG,
  // play() 被拒（自动播放策略）：接入方要靠 muted / 用户手势解决，不是播放器故障
  [ERROR_CODE.PLAY_FAILED]: ERROR_DOMAIN.CONFIG,
}

/**
 * 求错误码所属的域。未知码返回 `ERROR_DOMAIN.UNKNOWN`（**不猜测、不并入其它域**）。
 *
 * 同步、纯函数、无依赖 —— 接入方可在上报管道里直接调用，替代自己维护的
 * 「错误码白名单 Set + message 关键词兜底」那套逻辑。
 */
export function errorDomainOf(code: string | undefined | null): ErrorDomain {
  if (!code) return ERROR_DOMAIN.UNKNOWN
  return DOMAIN_BY_CODE[code] ?? ERROR_DOMAIN.UNKNOWN
}


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
 * 原生 `<video>` 的 `MediaError` → SDK 错误码映射（NativeKernel / 渐进式直连路径）。
 *
 * 为什么必须按 `code` 分派：`MediaError.code` 是 HTML 规范里的**定值枚举**（1–4），
 * 语义是确定的；若像早期实现那样一律映射成 `network_error`，接入方按错误码分流
 * 「解码异常 / 接口与 CDN 异常」时就会整体错位 —— 编解码不兼容会被标成网络问题，
 * 排查方向直接跑偏。
 *
 * | code | 规范常量 | 语义 | 映射 | fatal |
 * |---|---|---|---|---|
 * | 1 | `MEDIA_ERR_ABORTED` | 用户/脚本主动中止（换源、销毁） | **不上报**（返回 null） | — |
 * | 2 | `MEDIA_ERR_NETWORK` | 下载中断 | `network_error` | false |
 * | 3 | `MEDIA_ERR_DECODE` | 解码失败（码流损坏 / 编码不兼容） | `media_decode_error` | true |
 * | 4 | `MEDIA_ERR_SRC_NOT_SUPPORTED` | 源不可用 | 含网络痕迹 → `network_error`；否则 `media_src_not_supported` | 前者 false / 后者 true |
 * | 其他 | —— | 未定义（老浏览器不实现 `code`） | `network_error`（保持历史行为） | false |
 *
 * code=4 需二次判定的原因：原生路径下「地址 404 / 服务不可达」与「容器格式不支持」
 * 都表现为 `SRC_NOT_SUPPORTED`，仅凭 code 无法区分 —— 前者应走重连，后者应直接放弃。
 *
 * @returns 映射结果；`null` 表示**不应上报**（主动中止不是故障）
 */
export function mapMediaErrorCode(
  code: number | undefined,
  message = '',
): { code: string; fatal: boolean } | null {
  switch (code) {
    // 1 ABORTED：换源 / destroy / 用户操作导致的中止，属正常竞态，上报即噪声
    case 1:
      return null
    case 2:
      return { code: ERROR_CODE.NETWORK_ERROR, fatal: false }
    case 3:
      return { code: ERROR_CODE.MEDIA_DECODE_ERROR, fatal: true }
    case 4: {
      const msg = (message ?? '').toLowerCase()
      // 网络痕迹（404/403/加载失败）→ 按可恢复的网络错误走重连
      return /404|403|not\s?found|network|load|timeout/.test(msg)
        ? { code: ERROR_CODE.NETWORK_ERROR, fatal: false }
        : { code: ERROR_CODE.MEDIA_SRC_NOT_SUPPORTED, fatal: true }
    }
    default:
      // code 缺失或越界：浏览器实现差异（部分 WebView / 极简 DOM 替身不给 code），
      // 保持既有可恢复语义，避免把偶发错误升级成 fatal 而中断自动重连。
      return { code: ERROR_CODE.NETWORK_ERROR, fatal: false }
  }
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
