/**
 * 测试用 DOM / 媒体栈替身。
 *
 * 为什么需要它：`jsdom` / `happy-dom` 里的 `<video>` 只是「认得这个标签」，
 * 没有解码器、没有 MSE、`play()` 不会派发 `playing`、`currentTime` 不会自走。
 * 因此无法依赖环境自带的 HTMLMediaElement —— 必须自建替身（test double）。
 *
 * 本文件把原 `verify/smoke.mjs` 里的手写 mock 沉淀为可复用 fixtures，
 * 同时被 Vitest 单测与旧 smoke 脚本共享，避免两处维护。
 */

export interface FakeTimeRanges {
  length: number
  start(i: number): number
  end(i: number): number
}

/** 构造一个 TimeRanges 替身（从区间数组） */
export function makeTimeRanges(ranges: Array<[number, number]>): FakeTimeRanges {
  return {
    length: ranges.length,
    start: (i: number) => ranges[i][0],
    end: (i: number) => ranges[i][1],
  }
}

export interface FakeMediaElement {
  tagName: string
  style: Record<string, string>
  children: unknown[]
  attributes: Record<string, string>
  volume: number
  muted: boolean
  currentTime: number
  paused: boolean
  poster: string
  src: string
  autoplay: boolean
  currentSrc: string
  duration: number
  videoWidth: number
  videoHeight: number
  buffered: FakeTimeRanges
  setAttribute(k: string, v: string): void
  removeAttribute(k: string): void
  getAttribute(k: string): string | undefined
  appendChild(c: unknown): unknown
  /** 真实 DOM 的 `Element.replaceChildren`：清空后追加（清晰度面板用它避免 HTML 字符串拼接） */
  replaceChildren(...nodes: unknown[]): void
  remove(): void
  load(): void
  play(): Promise<void>
  pause(): void
  canPlayType(): string
  addEventListener(t: string, fn: (...args: unknown[]) => void): void
  removeEventListener(t: string, fn: (...args: unknown[]) => void): void
  /** 测试专用：同步派发事件（真实 <video> 无此方法） */
  _fire(t: string, ...args: unknown[]): void
}

export function makeEl(tag: string): FakeMediaElement {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const el: FakeMediaElement = {
    tagName: tag,
    style: {},
    children: [],
    attributes: {},
    // 状态属性
    volume: 1,
    muted: false,
    currentTime: 0,
    paused: true,
    poster: '',
    src: '',
    autoplay: false,
    currentSrc: '',
    duration: NaN, // 真实 <video> 未加载时为 NaN
    videoWidth: 0,
    videoHeight: 0,
    buffered: makeTimeRanges([]),
    // 方法
    setAttribute(k, v) {
      el.attributes[k] = v
    },
    removeAttribute(k) {
      delete el.attributes[k]
    },
    getAttribute(k) {
      return el.attributes[k]
    },
    appendChild(c) {
      el.children.push(c)
      return c
    },
    replaceChildren(...nodes) {
      el.children.length = 0
      el.children.push(...nodes)
    },
    remove() {},
    load() {},
    play() {
      el.paused = false
      return Promise.resolve()
    },
    pause() {
      el.paused = true
    },
    canPlayType() {
      return ''
    },
    addEventListener(t, fn) {
      ;(listeners[t] ||= []).push(fn)
    },
    removeEventListener(t, fn) {
      const l = listeners[t] || []
      const i = l.indexOf(fn)
      if (i >= 0) l.splice(i, 1)
    },
    _fire(t, ...args) {
      ;(listeners[t] || []).forEach((f) => f(...args))
    },
  }
  return el
}

/**
 * 安装最小 DOM 环境到 globalThis（window / document / navigator）。
 * 返回 `reset()` 以便测试间清理，以及 `doc`（可派发 document 事件，如 fullscreenchange）。
 */
/**
 * 在替身里**保持单例**的 tag（见 `createElement` 注释）。
 * 只有 `<video>`：SDK 内部创建它，而测试要在 `beforeEach` 里提前持引用。
 */
const SINGLETON_TAGS = new Set(['video'])

export function installDom(): { els: Record<string, FakeMediaElement>; doc: FakeDocument; reset: () => void } {
  const els: Record<string, FakeMediaElement> = {}
  const container = makeEl('div')
  const docListeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const prev = {
    window: (globalThis as Record<string, unknown>).window,
    document: (globalThis as Record<string, unknown>).document,
    navigator: (globalThis as Record<string, unknown>).navigator,
  }

  ;(globalThis as Record<string, unknown>).window = {
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
    clearTimeout: (id?: number) => clearTimeout(id as never),
    setInterval: (fn: () => void, ms?: number) => setInterval(fn, ms),
    clearInterval: (id?: number) => clearInterval(id as never),
  }

  const doc: FakeDocument = {
    visibilityState: 'visible',
    // 全屏元素：测试可写，用于驱动 PlayerState.fullscreen 同步
    fullscreenElement: null,
    // `<video>` 保持**单例**（见 SINGLETON_TAGS）；其余 tag 按真实语义**每次新建**。
    // 早期版本对所有 tag 记忆化，导致「两个 `<button>` 控件」或「两个 `<option>`」
    // 拿到同一对象、互相覆盖属性，断言失去意义。
    // 未走单例分支时仍把最新实例记进 `els[tag]`，便于测试取（如 poster 图层的 `<img>`）。
    createElement: (tag: string) => {
      if (SINGLETON_TAGS.has(tag)) return (els[tag] ||= makeEl(tag))
      const el = makeEl(tag)
      els[tag] = el
      return el
    },
    querySelector: () => container,
    addEventListener(t, fn) {
      ;(docListeners[t] ||= []).push(fn)
    },
    removeEventListener(t, fn) {
      const l = docListeners[t] || []
      const i = l.indexOf(fn)
      if (i >= 0) l.splice(i, 1)
    },
    _fire(t, ...args) {
      ;(docListeners[t] || []).forEach((f) => f(...args))
    },
  }
  ;(globalThis as Record<string, unknown>).document = doc

  Object.defineProperty(globalThis, 'navigator', {
    value: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
      onLine: true,
      platform: 'Win32',
      vendor: '',
      maxTouchPoints: 0,
      connection: undefined,
    },
    configurable: true,
    writable: true,
  })

  return {
    els,
    doc,
    reset() {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete (globalThis as Record<string, unknown>)[k]
        else (globalThis as Record<string, unknown>)[k] = v
      }
    },
  }
}

/** 最小 document：除 DOM 装配外，支持 `fullscreenElement` 写入与事件派发 */
export interface FakeDocument {
  visibilityState: string
  fullscreenElement: Element | null
  createElement(tag: string): FakeMediaElement
  querySelector(sel: string): FakeMediaElement
  addEventListener(t: string, fn: (...args: unknown[]) => void): void
  removeEventListener(t: string, fn: (...args: unknown[]) => void): void
  _fire(t: string, ...args: unknown[]): void
}
