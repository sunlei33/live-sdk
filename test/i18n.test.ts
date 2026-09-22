import { describe, it, expect, beforeEach } from 'vitest'
import { t, setLocale, getLocale } from '../src/utils/i18n'
import { MSG, DEFAULT_LOCALE } from '../src/constants'
import { MESSAGES } from '../src/utils/messages'

describe('运行期消息：编号 + locale', () => {
  beforeEach(() => setLocale(DEFAULT_LOCALE))

  it('缺省语言是英文；切到 zh 后同一条编号给中文', () => {
    expect(getLocale()).toBe('en')
    expect(t(MSG.BUFFER_STALL_TIMEOUT)).toBe('[LV-3003] buffer stalled, timed out')

    setLocale('zh')
    expect(getLocale()).toBe('zh')
    expect(t(MSG.BUFFER_STALL_TIMEOUT)).toBe('[LV-3003] 缓冲停滞超时')
  })

  it('消息自带编号前缀 `[LV-xxxx]` —— 报障可引用、文档可索引、接入方告警可锚定', () => {
    expect(t(MSG.RETRY_EXHAUSTED, { max: 3, code: 'load_timeout' })).toBe(
      '[LV-3004] Retry exhausted after 3 attempts (load_timeout)',
    )
  })

  it('参数插值：数字与字符串占位符都按序替换', () => {
    expect(t(MSG.RETRY_ATTEMPT, { count: 2, code: 'network_error', url: 'https://cdn/a.m3u8' })).toBe(
      '[LV-3006] reconnect attempt #2 (network_error) → https://cdn/a.m3u8',
    )
  })

  it('未提供的占位符**原样保留**（便于一眼看出漏传，而不是静默变成 undefined）', () => {
    expect(t(MSG.RATE_INVALID)).toBe('[LV-1002] invalid playback rate, ignored: {rate}')
  })

  it('文案表覆盖全部编号，且两种语言都非空（编号与文案不会单边漂移）', () => {
    const ids = Object.values(MSG)
    expect(ids.length).toBeGreaterThan(30)
    for (const id of ids) {
      const entry = MESSAGES[id as keyof typeof MESSAGES]
      expect(entry, `缺少文案：${id}`).toBeDefined()
      expect(entry.en.length, `英文文案为空：${id}`).toBeGreaterThan(0)
      expect(entry.zh.length, `中文文案为空：${id}`).toBeGreaterThan(0)
    }
  })

  it('编号唯一，且形如 `LV-<四位>`（分区见 constants.ts#MSG）', () => {
    const ids = Object.values(MSG)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^LV-\d{4}$/)
  })
})
