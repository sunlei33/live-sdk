import { describe, it, expect } from 'vitest'
import { mapErrorCode, isFatalKernelError } from '../src/utils/errors'
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
