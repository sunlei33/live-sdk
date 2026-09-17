import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installDom } from './fixtures/dom'
import { MIME_HLS, MIME_MP4, supportsMSE } from '../src/platform/web/capabilities'
import { WebMediaSurface } from '../src/platform/web/WebMediaSurface'

type Dom = ReturnType<typeof installDom>

const g = globalThis as unknown as Record<string, unknown>
const win = (): Record<string, unknown> => g.window as Record<string, unknown>

/**
 * 原 `test/sniffer.test.ts`，随 `utils/sniffer.ts` 的**语义拆解**而重写。
 *
 * 拆解的原因：原模块整个都是 Web 平台实现（`window` 能力位 + `video.canPlayType`），
 * 却放在声明为「平台无关纯函数」的 `utils/` 下，而且分层门看不到它（判据只认 DOM 全局，
 * 而 `'MediaSource' in window` 没有点号）。按语义分三处：
 *
 * | 原函数 | 现在 |
 * |---|---|
 * | `supportsMSE` | `platform/web/capabilities`（宿主能力） |
 * | `canPlayNativeHLS` / `canPlayNativeMP4` | **`MediaSurface.canPlay()` 契约**（媒体设备能力） |
 * | `supportsManagedMediaSource` | 删除（hls.js 自带可用性降级，`HlsKernel` 恒传 `true`） |
 *
 * 环境在**调用时**读取 —— 早期版本用模块级 `const hasWindow = ...` 捕获，值会在 import 时固化，
 * 测试里 `installDom()`（晚于 import）根本不生效，于是它长期没有单测。
 */
describe('Web 宿主能力探测：只问能力，不问身份', () => {
  let dom: Dom

  beforeEach(() => {
    dom = installDom()
  })
  afterEach(() => {
    dom.reset()
  })

  it('window 有 MediaSource → true', () => {
    win().MediaSource = function MediaSource() {}
    expect(supportsMSE()).toBe(true)
  })

  it('window 无 MediaSource（Safari <17.1 / 老 WebView）→ false', () => {
    expect(supportsMSE()).toBe(false)
  })

  it('【关键】环境在调用时读取 —— 后装的能力位立刻生效（模块级捕获会固化成过期值）', () => {
    expect(supportsMSE()).toBe(false) // 先在没有能力位的形态下问一次
    win().MediaSource = function MediaSource() {}
    expect(supportsMSE()).toBe(true) // 同一个模块实例必须立刻看到
  })

  it('MIME 常量是原生可播判定的入参（不该由各调用点各写一遍字符串）', () => {
    expect(MIME_HLS).toBe('application/vnd.apple.mpegurl')
    expect(MIME_MP4).toBe('video/mp4')
  })
})

describe('媒体设备能力：MediaSurface.canPlay（canPlayType 三态收敛为布尔）', () => {
  let dom: Dom

  beforeEach(() => {
    dom = installDom()
  })
  afterEach(() => {
    dom.reset()
  })

  /** 造一个 canPlayType 行为可指定的媒体面 */
  const surfaceWith = (fn: (type: string) => string): WebMediaSurface => {
    const s = new WebMediaSurface()
    ;(s.el as unknown as { canPlayType: unknown }).canPlayType = fn
    return s
  }

  it('返回非空串即视为可播（Safari 对 mpegurl 返回 "maybe"）', () => {
    expect(surfaceWith((t) => (t === MIME_HLS ? 'maybe' : '')).canPlay(MIME_HLS)).toBe(true)
  })

  it('返回空串（Chrome 无原生 HLS）→ false', () => {
    expect(surfaceWith(() => '').canPlay(MIME_HLS)).toBe(false)
  })

  it('MP4 与 HLS 分别判定，互不代表', () => {
    const s = surfaceWith((t) => (t === MIME_MP4 ? 'probably' : ''))
    expect(s.canPlay(MIME_MP4)).toBe(true)
    expect(s.canPlay(MIME_HLS)).toBe(false)
  })

  it('"probably" 与 "maybe" 都算可播（两者只表示把握程度，不表示可播与否）', () => {
    expect(surfaceWith(() => 'probably').canPlay(MIME_HLS)).toBe(true)
    expect(surfaceWith(() => 'maybe').canPlay(MIME_HLS)).toBe(true)
  })
})

describe('【回归】平台实现不再挂在 utils 下，也不再作为公开面导出', () => {
  it('utils/ 下已无 sniffer / fullscreen（它们是平台实现，已迁至 platform/web）', async () => {
    // 用变量路径 import：TS 无法在编译期解析，故这里是**运行时**断言（模块确实不存在）
    for (const gone of ['sniffer', 'fullscreen']) {
      const path = '../src/utils/' + gone
      await expect(import(/* @vite-ignore */ path), `src/utils/${gone}.ts 应已不存在`).rejects.toThrow()
    }
  })

  it('包入口不再导出 `sniffer` 命名空间（旧写法改用 player.canPlay(mime)）', async () => {
    const sdk = (await import('../src/index')) as unknown as Record<string, unknown>
    expect('sniffer' in sdk, 'sniffer 不应再是公开导出').toBe(false)
  })
})
