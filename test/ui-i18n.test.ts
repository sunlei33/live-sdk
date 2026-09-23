import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installDom, makeEl, type FakeMediaElement } from './fixtures/dom'
import { DEFAULT_LOCALE, MSG } from '../src/constants'
import { setLocale, uiText } from '../src/utils/i18n'

type Dom = ReturnType<typeof installDom>
type PlayerInstance = import('../src/core/Player').Player
/**
 * 夹具元素上被控件额外写入的字段。
 * `FakeMediaElement` 只声明了媒体相关属性，而控件还会写 `title` / `textContent` /
 * `innerHTML`（替身不拦属性赋值，直接落在对象上）。
 */
type El = FakeMediaElement & {
  title: string
  textContent: string
  innerHTML?: string
  value?: string
}

let dom: Dom
let video: FakeMediaElement
let PlayerCtor: typeof import('../src/core/Player').Player
let createWebPlatform: typeof import('../src/platform/web').createWebPlatform
let C: typeof import('../src/ui/controls')

/**
 * 最小内核替身：`load()` 即视为清单就绪。`levels` 非空时透出档位，
 * 用于驱动清晰度面板渲染（业务档位由 `play({ quality })` 提供，两者缺一都不会出档位）。
 */
function makeMockKernel(levels: Array<{ index: number; height: number; bitrate: number }> = []) {
  return class MockKernel {
    static readonly kernelName = 'MockKernel'
    static isSupported(): boolean {
      return true
    }
    readonly capabilities = {
      lowLatency: true,
      qualitySwitch: true,
      abr: true,
      stats: 'full' as const,
      nativeFallback: false,
    }
    private onEvent: (e: string, d?: unknown) => void
    constructor(opts: { onEvent: (e: string, d?: unknown) => void }) {
      this.onEvent = opts.onEvent
    }
    async load(): Promise<void> {
      this.onEvent('manifest_parsed', {})
      if (levels.length) this.onEvent('levels_updated', levels)
    }
    async switchURL(): Promise<void> {}
    switchQuality(): void {}
    getStats(): Record<string, unknown> {
      return {}
    }
    bufferInfo(): Record<string, unknown> {
      return { buffers: [], remaining: 0, length: 0, totalRemaining: 0, totalLength: 0, behind: 0 }
    }
    recover(): void {}
    destroy(): void {}
    getLevels(): unknown[] {
      return levels
    }
    getCurrentLevel(): number {
      return -1
    }
    setLiveLatency(): void {}
  }
}

function createPlayer(
  config: Record<string, unknown> = {},
  levels?: Array<{ index: number; height: number; bitrate: number }>,
): PlayerInstance {
  const platform = createWebPlatform({ kernel: makeMockKernel(levels) as never })
  return new PlayerCtor({ container: '#c', ...config } as never, platform as never)
}

/**
 * 挂载**单个**控件并返回夹具元素。
 *
 * ⚠️ 一次只挂一个同 tag 的控件：夹具的 `createElement` 按 tag 记忆化（同一 tag 返回同一实例），
 * 同时挂两个 `<button>` 控件会让它们互相覆盖属性，断言就失去意义。
 */
function mountOne<T extends { mount(r: HTMLElement, p: PlayerInstance): void; unmount(): void }>(
  Ctor: new () => T,
  p: PlayerInstance,
  tag: string,
): { inst: T; el: El } {
  const inst = new Ctor()
  inst.mount(p.root as HTMLElement, p)
  return { inst, el: dom.els[tag] as El }
}

beforeEach(async () => {
  dom = installDom()
  video = dom.els['video'] ?? (dom.els['video'] = makeEl('video'))
  PlayerCtor ??= (await import('../src/core/Player')).Player
  createWebPlatform ??= (await import('../src/platform/web')).createWebPlatform
  C ??= await import('../src/ui/controls')
  setLocale(DEFAULT_LOCALE)
})

afterEach(() => {
  setLocale(DEFAULT_LOCALE)
  dom.reset()
})

describe('UI 控件文案：继承 locale、取自同一张文案表', () => {
  it('全屏按钮（默认 en）：`Fullscreen`，且 tooltip 里**没有** `[LV-xxxx]` 编号', () => {
    const p = createPlayer()
    const { inst, el } = mountOne(C.FullscreenButton, p, 'button')
    expect(el.title).toBe('Fullscreen')
    expect(el.getAttribute('aria-label')).toBe('Fullscreen')
    // 编号是给开发引用的，出现在 tooltip 里只是噪声
    expect(el.title).not.toContain('LV-')
    inst.unmount()
    p.destroy()
  })

  it('全屏按钮（`PlayerConfig.locale: "zh"`）：`全屏` → 进入全屏后变 `退出全屏`（动作式文案）', () => {
    const p = createPlayer({ locale: 'zh' })
    const { inst, el } = mountOne(C.FullscreenButton, p, 'button')
    expect(el.title).toBe('全屏')

    // 驱动真实的全屏态同步链路（而非直接改文案）
    ;(p.root as unknown as { contains: (n: unknown) => boolean }).contains = (n) => n === video
    dom.doc.fullscreenElement = p.root as unknown as Element
    dom.doc._fire('fullscreenchange')
    expect(el.title).toBe('退出全屏')
    expect(el.getAttribute('aria-label')).toBe('退出全屏')
    inst.unmount()
    p.destroy()
  })

  it('播放按钮：补上可访问名（原实现是 emoji-only，读屏拿到的是「空按钮」）', () => {
    const p = createPlayer()
    const { inst, el } = mountOne(C.PlayButton, p, 'button')
    expect(el.title).toBe('Play')
    expect(el.getAttribute('aria-label')).toBe('Play')
    inst.unmount()
    p.destroy()
  })

  it('静音按钮：文案是**动作式** —— 已静音时提示 `Unmute` 而不是描述状态', () => {
    const p = createPlayer()
    const { inst, el } = mountOne(C.MuteButton, p, 'button')
    expect(el.getAttribute('aria-label')).toBe('Mute')
    p.mute(true)
    expect(el.title).toBe('Unmute')
    expect(el.getAttribute('aria-label')).toBe('Unmute')
    inst.unmount()
    p.destroy()
  })

  it('音量滑块（zh）：只给 `aria-label`、不给 `title`（拖动时频繁弹提示是噪声）', () => {
    const p = createPlayer({ locale: 'zh' })
    const { inst, el } = mountOne(C.VolumeControl, p, 'input')
    expect(el.getAttribute('aria-label')).toBe('音量')
    expect(el.getAttribute('title')).toBeUndefined()
    inst.unmount()
    p.destroy()
  })

  it('清晰度下拉（zh）：无档位时隐藏；起播且有档位后首项为本地化的「自动」', async () => {
    const levels = [{ index: 0, height: 720, bitrate: 2000 }]
    const p = createPlayer({ locale: 'zh' }, levels)
    const { inst, el } = mountOne(C.QualityPanel, p, 'select')
    expect(el.style.display).toBe('none') // 未起播 → 无档位 → 隐藏（既有行为不变）

    await p.play({ url: 'https://cdn/a.m3u8', quality: [{ id: 1, height: 720 }] } as never)
    expect(el.style.display).toBe('')
    expect(el.innerHTML).toContain('<option value="-1">自动</option>')
    inst.unmount()
    p.destroy()
  })

  it('运行中切语言：已挂载控件**立即**重绘（不依赖状态变化）', () => {
    const p = createPlayer()
    const { inst, el } = mountOne(C.FullscreenButton, p, 'button')
    expect(el.title).toBe('Fullscreen')
    // 关键：这一步不改任何播放状态 —— 只靠 `subscribe` 是刷新不了的
    setLocale('zh')
    expect(el.title).toBe('全屏')
    inst.unmount()
    p.destroy()
  })

  it('unmount 后语言变更不再触碰已卸载控件（监听器已解绑，不泄漏）', () => {
    const p = createPlayer()
    const { inst, el } = mountOne(C.FullscreenButton, p, 'button')
    inst.unmount()
    const stale = el.title
    setLocale('zh')
    // 若监听器泄漏，这里会变成「全屏」
    expect(el.title).toBe(stale)
    p.destroy()
  })

  it('控件显示的就是 `uiText()` 的结果（同源，只是不带编号）', () => {
    expect(uiText(MSG.UI_FULLSCREEN_ENTER)).toBe('Fullscreen')
    expect(uiText(MSG.UI_QUALITY_AUTO)).toBe('Auto')
    expect(uiText(MSG.UI_VOLUME)).toBe('Volume')
  })
})
