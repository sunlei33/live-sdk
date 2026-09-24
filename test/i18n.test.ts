import { describe, it, expect, beforeEach, vi } from 'vitest'
import { t, uiText, setLocale, getLocale, onLocaleChange } from '../src/utils/i18n'
import { MSG, DEFAULT_LOCALE, type MsgId } from '../src/constants'

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
    // ⚠️ 文案表（`MESSAGES`）已并入 `utils/i18n.ts` 且**不导出** —— 故改从**取用入口**反查：
    // 缺文案时 `pick()` 会兜底成编号本身，于是「取到的文案 === 编号」就是「这条编号没有文案」。
    const ids = Object.values(MSG)
    expect(ids.length).toBeGreaterThan(30)
    for (const id of ids) {
      for (const loc of ['en', 'zh'] as const) {
        setLocale(loc)
        const text = uiText(id as MsgId)
        expect(text, `缺少文案：${id}（${loc}）`).not.toBe(id)
        expect(text.trim().length, `文案为空：${id}（${loc}）`).toBeGreaterThan(0)
      }
    }
    setLocale(DEFAULT_LOCALE)
  })

  it('编号唯一，且形如 `LV-<四位>`（分区见 constants.ts#MSG）', () => {
    const ids = Object.values(MSG)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^LV-\d{4}$/)
  })

  it('`uiText()` 给**纯文案**（无编号）—— 同一个编号，`t()` 带编号、`uiText()` 不带', () => {
    expect(uiText(MSG.UI_FULLSCREEN_ENTER)).toBe('Fullscreen')
    expect(t(MSG.UI_FULLSCREEN_ENTER)).toBe('[LV-7002] Fullscreen')

    setLocale('zh')
    expect(uiText(MSG.UI_FULLSCREEN_ENTER)).toBe('全屏')
    expect(t(MSG.UI_FULLSCREEN_ENTER)).toBe('[LV-7002] 全屏')
  })

  it('UI 文案的编号也走同一套校验（分区 LV-7xxx，两种语言都非空）', () => {
    const uiIds = Object.entries(MSG).filter(([k]) => k.startsWith('UI_'))
    expect(uiIds.length).toBeGreaterThan(0)
    for (const [key, id] of uiIds) {
      expect(id, `${key} 不在 LV-7xxx 分区`).toMatch(/^LV-7\d{3}$/)
      for (const loc of ['en', 'zh'] as const) {
        setLocale(loc)
        const text = uiText(id as MsgId)
        expect(text, `缺少 ${loc} 文案：${id}`).not.toBe(id)
        expect(text.trim().length, `${loc} 文案为空：${id}`).toBeGreaterThan(0)
      }
    }
    setLocale(DEFAULT_LOCALE)
  })
})

describe('语言变更通知（UI 重绘依赖它）', () => {
  beforeEach(() => setLocale(DEFAULT_LOCALE))

  it('`setLocale` 幂等：同值不触发通知，变更才触发', () => {
    setLocale('en')
    let hits = 0
    const off = onLocaleChange(() => hits++)

    setLocale('en') // 同值 → 静默（否则多实例以同一 locale 构造会白刷一遍 UI）
    expect(hits).toBe(0)

    setLocale('zh')
    expect(hits).toBe(1)

    setLocale('zh')
    expect(hits).toBe(1)

    off()
    setLocale('en')
    expect(hits).toBe(1) // 已解绑
  })

  it('监听器抛异常不会让 `setLocale` 抛出 —— 它跑在 `new Player()` 里，抛出等于构造失败', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    setLocale('en')

    const off = onLocaleChange(() => {
      throw new Error('boom')
    })
    expect(() => setLocale('zh')).not.toThrow()
    // 异常被记录（不静默吞掉），且带上可引用的编号
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('[LV-9002]'))).toBe(true)

    off()
    errSpy.mockRestore()
  })
})
