import { describe, it, expect } from 'vitest'
import { mapErrorCode, isFatalKernelError, mapMediaErrorCode } from '../src/utils/errors'
import { ERROR_CODE } from '../src/constants'

describe('mapErrorCode', () => {
  it('【回归】hls.js camelCase details 必须被识别（原实现只匹配大写 → 全落 UNKNOWN）', () => {
    expect(mapErrorCode('manifestLoadError')).toBe(ERROR_CODE.MANIFEST_LOAD_ERROR)
    expect(mapErrorCode('fragLoadError')).toBe(ERROR_CODE.FRAG_LOAD_ERROR)
    expect(mapErrorCode('networkError')).toBe(ERROR_CODE.NETWORK_ERROR)
  })

  it('全大写常量同样识别（自研内核风格）', () => {
    expect(mapErrorCode('MANIFEST_LOAD_ERROR')).toBe(ERROR_CODE.MANIFEST_LOAD_ERROR)
    expect(mapErrorCode('FRAG_LOAD_ERROR')).toBe(ERROR_CODE.FRAG_LOAD_ERROR)
    expect(mapErrorCode('NETWORK_ERROR')).toBe(ERROR_CODE.NETWORK_ERROR)
  })

  it('大小写混合也识别', () => {
    expect(mapErrorCode('ManifestLoadError')).toBe(ERROR_CODE.MANIFEST_LOAD_ERROR)
    expect(mapErrorCode('fRaGlOaDeRrOr')).toBe(ERROR_CODE.FRAG_LOAD_ERROR)
  })

  it('hls.js 的 manifestLoadTimeOut / fragLoadTimeOut 归入对应类别', () => {
    expect(mapErrorCode('manifestLoadTimeOut')).toBe(ERROR_CODE.MANIFEST_LOAD_ERROR)
    expect(mapErrorCode('fragLoadTimeOut')).toBe(ERROR_CODE.FRAG_LOAD_ERROR)
  })

  it('【回归】404 来自 HTTP 状态码（hls.js 把状态放在 data.response.code）', () => {
    // details 恒为 manifestLoadError，仅凭 details 无法分辨 404
    expect(mapErrorCode('manifestLoadError', 404)).toBe(ERROR_CODE.MANIFEST_404)
    expect(mapErrorCode('manifestLoadError', 500)).toBe(ERROR_CODE.MANIFEST_LOAD_ERROR)
    expect(mapErrorCode('manifestLoadError')).toBe(ERROR_CODE.MANIFEST_LOAD_ERROR)
  })

  it('details 里带 404 时也能识别（兼容自研内核）', () => {
    expect(mapErrorCode('MANIFEST_404')).toBe(ERROR_CODE.MANIFEST_404)
  })

  it('未归类 → UNKNOWN', () => {
    expect(mapErrorCode('bufferAppendError')).toBe(ERROR_CODE.UNKNOWN)
    expect(mapErrorCode('')).toBe(ERROR_CODE.UNKNOWN)
    expect(mapErrorCode(undefined as unknown as string)).toBe(ERROR_CODE.UNKNOWN)
  })

  it('非 MANIFEST 的 404 不应误判为 manifest_404', () => {
    expect(mapErrorCode('fragLoadError', 404)).toBe(ERROR_CODE.FRAG_LOAD_ERROR)
  })
})

describe('isFatalKernelError', () => {
  it('【回归】hls.js 小写 details + fatal=true 必须判为 fatal', () => {
    expect(isFatalKernelError('manifestLoadError', 'networkError', true)).toBe(true)
    expect(isFatalKernelError('manifestIncompatibleCodecsError', 'mediaError', true)).toBe(true)
    expect(isFatalKernelError('keyLoadError', 'keySystemError', true)).toBe(true)
  })

  it('内核未标 fatal → 一律非 fatal', () => {
    expect(isFatalKernelError('manifestLoadError', 'networkError', false)).toBe(false)
  })

  it('mediaError 类型（大小写不敏感）也算 fatal', () => {
    expect(isFatalKernelError('bufferAppendError', 'mediaError', true)).toBe(true)
    expect(isFatalKernelError('bufferAppendError', 'MediaError', true)).toBe(true)
  })

  it('普通分片错误非 fatal', () => {
    expect(isFatalKernelError('fragLoadError', 'networkError', true)).toBe(false)
  })
})

describe('mapMediaErrorCode（原生 <video> 的 MediaError）', () => {
  it('【回归】MEDIA_ERR_DECODE(3) 必须与网络错误分开且 fatal', () => {
    // 原实现把 <video>.error 一律映射成 network_error + 可恢复，导致：
    //   ① 解码失败被打进「接口与 CDN 异常」分类（分流错位）
    //   ② 对不可能恢复的解码失败发起重连（无意义重试）
    const r = mapMediaErrorCode(3, 'Failed to decode')
    expect(r).toEqual({ code: ERROR_CODE.MEDIA_DECODE_ERROR, fatal: true })
  })

  it('MEDIA_ERR_NETWORK(2) → network_error，保持可恢复', () => {
    expect(mapMediaErrorCode(2, '')).toEqual({ code: ERROR_CODE.NETWORK_ERROR, fatal: false })
  })

  it('MEDIA_ERR_ABORTED(1) 不上报（换源/销毁引发的中止不是故障）', () => {
    expect(mapMediaErrorCode(1, 'aborted by user')).toBeNull()
  })

  it('MEDIA_ERR_SRC_NOT_SUPPORTED(4)：无网络痕迹 → 源不支持且 fatal', () => {
    expect(mapMediaErrorCode(4, 'no supported source was found')).toEqual({
      code: ERROR_CODE.MEDIA_SRC_NOT_SUPPORTED,
      fatal: true,
    })
  })

  it('MEDIA_ERR_SRC_NOT_SUPPORTED(4) 带网络痕迹 → 归网络错误走重连', () => {
    // 原生路径下「地址 404」与「格式不支持」都表现为 SRC_NOT_SUPPORTED，
    // 靠 message 关键词二次区分：前者应重连、后者应放弃。
    expect(mapMediaErrorCode(4, 'HTTP 404 Not Found')).toEqual({ code: ERROR_CODE.NETWORK_ERROR, fatal: false })
    expect(mapMediaErrorCode(4, 'Load failed')).toEqual({ code: ERROR_CODE.NETWORK_ERROR, fatal: false })
  })

  it('code 缺失/越界 → 保持历史可恢复语义（不误升级为 fatal）', () => {
    expect(mapMediaErrorCode(undefined, 'unknown')).toEqual({ code: ERROR_CODE.NETWORK_ERROR, fatal: false })
    expect(mapMediaErrorCode(99, 'unknown')).toEqual({ code: ERROR_CODE.NETWORK_ERROR, fatal: false })
  })

  it('三个码值互不重叠（错误分流的前提）', () => {
    const codes = new Set([ERROR_CODE.MEDIA_DECODE_ERROR, ERROR_CODE.MEDIA_SRC_NOT_SUPPORTED, ERROR_CODE.NETWORK_ERROR])
    expect(codes.size).toBe(3)
  })
})
