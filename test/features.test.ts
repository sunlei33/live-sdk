import { describe, it, expect } from 'vitest'
import { matchFeature, isClientUsable, isServerUsable } from '../src/utils/features'

describe('isClientUsable', () => {
  it('supported / degraded 可用', () => {
    expect(isClientUsable('supported')).toBe(true)
    expect(isClientUsable('degraded')).toBe(true)
  })
  it('absent / unknown 不可用', () => {
    expect(isClientUsable('absent')).toBe(false)
    expect(isClientUsable('unknown')).toBe(false)
  })
})

describe('isServerUsable', () => {
  it('仅 supported 可用', () => {
    expect(isServerUsable('supported')).toBe(true)
    expect(isServerUsable('absent')).toBe(false)
    expect(isServerUsable('degraded')).toBe(false)
    expect(isServerUsable('unknown')).toBe(false)
  })
})

describe('matchFeature 端到端对齐', () => {
  it('两端都 supported → matched', () => {
    const r = matchFeature('abr', 'supported', 'supported')
    expect(r.matched).toBe(true)
    expect(r.detail).toBeUndefined()
  })

  it('【回归】server=unknown 不得判 matched（旧 bug：airplay 特例绕过服务端判据）', () => {
    const r = matchFeature('airplay', 'supported', 'unknown')
    expect(r.matched).toBe(false)
    expect(r.detail).toBe('服务端未提供 / not provided by the server')
  })

  it('server=absent → 未对齐，detail 指「服务端未提供」', () => {
    const r = matchFeature('lowLatency', 'supported', 'absent')
    expect(r.matched).toBe(false)
    expect(r.detail).toBe('服务端未提供 / not provided by the server')
  })

  it('client=absent → 未对齐，detail 指「客户端不支持」', () => {
    const r = matchFeature('drm', 'absent', 'supported')
    expect(r.matched).toBe(false)
    expect(r.detail).toBe('客户端不支持 / unsupported by the client')
  })

  it('airplay 原生回退：client=degraded + server=supported → matched', () => {
    const r = matchFeature('airplay', 'degraded', 'supported')
    expect(r.matched).toBe(true)
    expect(r.detail).toBe('原生回退路径，投屏由系统接管 / native fallback path; casting is handled by the system')
  })

  it('airplay MSE 路径：client=supported + server=supported → matched 且无 detail', () => {
    const r = matchFeature('airplay', 'supported', 'supported')
    expect(r.matched).toBe(true)
    expect(r.detail).toBeUndefined()
  })

  it('degraded 客户端 + 服务端未提供 → 仍未对齐（degraded 不放行服务端缺失）', () => {
    const r = matchFeature('airplay', 'degraded', 'absent')
    expect(r.matched).toBe(false)
    expect(r.detail).toBe('服务端未提供 / not provided by the server')
  })
})
