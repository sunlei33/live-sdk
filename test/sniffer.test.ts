import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installDom, makeEl } from './fixtures/dom'
import { supportsMSE, supportsManagedMediaSource, canPlayNativeHLS, canPlayNativeMP4 } from '../src/utils/sniffer'

type Dom = ReturnType<typeof installDom>

const g = globalThis as unknown as Record<string, unknown>
const win = (): Record<string, unknown> => g.window as Record<string, unknown>

/**
 * sniffer 的环境**在调用时**读取，因此这里可以先用假 window 装配能力位再断言。
 *
 * 这是本文件存在的前提：早期版本用模块级 `const hasWindow = ...` 捕获环境，
 * 值会在 import 时固化，测试里 `installDom()`（晚于 import）根本不生效 ——
 * 于是它长期没有单测，也纵容了 5 个零引用函数活到 0.5.0（见下方最后一条用例）。
 */
describe('sniffer：只问能力，不问身份', () => {
  let dom: Dom

  beforeEach(() => {
    dom = installDom()
  })
  afterEach(() => {
    dom.reset()
  })

  describe('MSE 能力', () => {
    it('window 有 MediaSource → true', () => {
      win().MediaSource = function MediaSource() {}
      expect(supportsMSE()).toBe(true)
    })

    it('window 无 MediaSource（Safari <17.1 / 老 WebView）→ false', () => {
      expect(supportsMSE()).toBe(false)
    })

    it('【关键】MMS 与 MSE 是两个独立能力位，不能用一个判另一个', () => {
      win().ManagedMediaSource = function MMS() {}
      expect(supportsManagedMediaSource()).toBe(true)
      expect(supportsMSE()).toBe(false) // MMS 不会让 supportsMSE 变 true

      win().MediaSource = function MediaSource() {}
      expect(supportsMSE()).toBe(true)
      expect(supportsManagedMediaSource()).toBe(true)
    })

    it('【关键】环境在调用时读取 —— 后装的能力位立刻生效（模块级捕获会固化成过期值）', () => {
      expect(supportsMSE()).toBe(false) // 先在没有能力位的形态下问一次
      win().MediaSource = function MediaSource() {}
      expect(supportsMSE()).toBe(true) // 同一个模块实例必须立刻看到
    })
  })

  describe('原生可播判定（canPlayType）', () => {
    const videoWith = (fn: (type: string) => string): HTMLVideoElement => {
      const v = makeEl('video')
      v.canPlayType = fn as never
      return v as unknown as HTMLVideoElement
    }

    it('HLS：返回非空串即视为可播（Safari 对 mpegurl 返回 "maybe"）', () => {
      expect(canPlayNativeHLS(videoWith((t) => (t === 'application/vnd.apple.mpegurl' ? 'maybe' : '')))).toBe(true)
    })

    it('HLS：返回空串（Chrome 无原生 HLS）→ false', () => {
      expect(canPlayNativeHLS(videoWith(() => ''))).toBe(false)
    })

    it('MP4 与 HLS 分别判定，互不代表', () => {
      const v = videoWith((t) => (t === 'video/mp4' ? 'probably' : ''))
      expect(canPlayNativeMP4(v)).toBe(true)
      expect(canPlayNativeHLS(v)).toBe(false)
    })
  })

  describe('【回归】不再导出 UA 嗅探与重复探测', () => {
    it('isIOS / isSafari / isAndroid / supportsH264 / canAutoplay 均已删除', async () => {
      // 平台差异必须一律走能力判定：UA 会骗人（iPadOS 伪装 macOS、Chrome/Edge 的 UA 含 "Safari"）。
      // 留着 UA 嗅探等于给后人留一条「写回平台分支」的退路 —— 这是删除它们的主因。
      // supportsH264 由 hls.js 的 Hls.isSupported() 覆盖；canAutoplay 已改由运行时 playIntent 承担。
      const mod = (await import('../src/utils/sniffer')) as unknown as Record<string, unknown>
      for (const gone of ['isIOS', 'isSafari', 'isAndroid', 'supportsH264', 'canAutoplay']) {
        expect(mod[gone], `${gone} 不应再导出`).toBeUndefined()
      }
    })
  })
})
