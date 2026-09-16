import { describe, it, expect } from 'vitest'
import { resolveFullscreenPlan, isPlayerFullscreen } from '../src/utils/fullscreen'

/** 构造只带所需能力的假元素（结构类型足够，不必是真 DOM） */
function el(over: Record<string, unknown> = {}): Element {
  return { contains: () => false, ...over } as unknown as Element
}
function video(over: Record<string, unknown> = {}): HTMLVideoElement {
  return { contains: () => false, ...over } as unknown as HTMLVideoElement
}

describe('resolveFullscreenPlan —— 目标与 API 选路', () => {
  it('缺省 target + 标准环境 → 全屏 <video>，走 requestFullscreen', () => {
    const v = video({ requestFullscreen: () => Promise.resolve() })
    expect(resolveFullscreenPlan(undefined, v)).toEqual({ element: v, api: 'requestFullscreen' })
  })

  it('缺省 target + iOS → 走 webkitEnterFullscreen（原生视频全屏）', () => {
    const v = video({ webkitEnterFullscreen: () => undefined })
    expect(resolveFullscreenPlan(undefined, v)).toEqual({ element: v, api: 'webkitEnterFullscreen' })
  })

  it('video 同时具备两种能力时，优先 webkitEnterFullscreen（兼容性更好）', () => {
    const v = video({
      webkitEnterFullscreen: () => undefined,
      requestFullscreen: () => Promise.resolve(),
    })
    expect(resolveFullscreenPlan(undefined, v).api).toBe('webkitEnterFullscreen')
  })

  it('【核心】target = 容器 → 全屏容器本身（控件随之可见）', () => {
    const v = video({ requestFullscreen: () => Promise.resolve() })
    const box = el({ requestFullscreen: () => Promise.resolve() })
    expect(resolveFullscreenPlan(box, v)).toEqual({ element: box, api: 'requestFullscreen' })
  })

  it('【iOS 回退】容器不支持元素全屏时，回退到原生视频全屏', () => {
    const v = video({ webkitEnterFullscreen: () => undefined }) // 容器无任何方法
    const box = el()
    expect(resolveFullscreenPlan(box, v)).toEqual({ element: v, api: 'webkitEnterFullscreen' })
  })

  it('容器只有 webkit 前缀方法 → 走 webkitRequestFullscreen', () => {
    const v = video({ webkitEnterFullscreen: () => undefined })
    const box = el({ webkitRequestFullscreen: () => undefined })
    expect(resolveFullscreenPlan(box, v)).toEqual({ element: box, api: 'webkitRequestFullscreen' })
  })

  it('容器优先标准 API 而非回退视频（即便 video 具备 iOS 能力）', () => {
    const v = video({ webkitEnterFullscreen: () => undefined })
    const box = el({ requestFullscreen: () => Promise.resolve() })
    const plan = resolveFullscreenPlan(box, v)
    expect(plan.element).toBe(box)
    expect(plan.api).toBe('requestFullscreen')
  })

  it('无任何全屏能力 → api = none（调用方静默降级）', () => {
    const v = video()
    const box = el()
    expect(resolveFullscreenPlan(box, v).api).toBe('none')
    expect(resolveFullscreenPlan(undefined, v).api).toBe('none')
  })
})

describe('isPlayerFullscreen —— 全屏态判定', () => {
  it('video 自身处于全屏 → true', () => {
    const v = video()
    expect(isPlayerFullscreen(v, v)).toBe(true)
  })

  it('【回归】容器全屏（fullscreenElement 是 video 的祖先）→ true', () => {
    // 早先实现只判 fullscreenElement === video，容器全屏恒为 false
    const v = video()
    const box = el({ contains: (n: unknown) => n === v })
    expect(isPlayerFullscreen(v, box)).toBe(true)
  })

  it('iOS 原生视频全屏（webkitDisplayingFullscreen）→ true，即便 fullscreenElement 为 null', () => {
    const v = video({ webkitDisplayingFullscreen: true })
    expect(isPlayerFullscreen(v, null)).toBe(true)
  })

  it('非全屏 → false', () => {
    expect(isPlayerFullscreen(video(), null)).toBe(false)
  })

  it('无关元素全屏（不包含 video）→ false', () => {
    expect(isPlayerFullscreen(video(), el())).toBe(false)
  })

  it('更外层（应用外壳）全屏 → true（视频确实占满屏幕，允许一键退出）', () => {
    const v = video()
    const shell = el({ contains: (n: unknown) => n === v })
    expect(isPlayerFullscreen(v, shell)).toBe(true)
  })

  it('退出全屏后回到 false', () => {
    const v = video()
    const box = el({ contains: (n: unknown) => n === v })
    expect(isPlayerFullscreen(v, box)).toBe(true)
    expect(isPlayerFullscreen(v, null)).toBe(false)
  })
})
