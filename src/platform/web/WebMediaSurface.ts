/**
 * Web 媒体面实现：抽象原生 `<video>`，抹平浏览器差异（内联播放 / 全屏 / 属性）。
 *
 * 由 `core/MediaProxy` 迁移而来（P1）。**迁移的内容不变，只多两件事**：
 * - 实现 `MediaSurface` 契约（新增 `raw` 与 `onFullscreenChange`）；
 * - 把「监听 `document` 的 fullscreenchange」从 `Player` 收进来 ——
 *   否则 core 里仍会残留 DOM 全局引用，等于没解耦干净。
 *
 * 归属说明：它是 **Web 平台的实现**，不再属于 `core`。
 * 其他宿主（小程序 / 原生播放器）写自己的 `MediaSurface`，core 不需要改。
 */
import type { MediaEventName, MediaSurface } from '../../types'
import { readBuffers } from '../../utils/buffer'
import { isPlayerFullscreen, resolveFullscreenPlan, type FullscreenTarget, type FullscreenVideo } from './fullscreen'

export class WebMediaSurface implements MediaSurface<HTMLVideoElement> {
  readonly el: HTMLVideoElement

  constructor() {
    const el = document.createElement('video')
    el.setAttribute('playsinline', '')
    el.setAttribute('webkit-playsinline', '')
    el.setAttribute('x5-playsinline', '') // 微信 / X5 内联播放
    el.setAttribute('x5-video-player-type', 'h5')
    el.setAttribute('x5-video-player-fullscreen', 'true')
    this.el = el
  }

  /** 契约要求的平台原生句柄（供 `player.media` 与 Web 内核使用）。 */
  get raw(): HTMLVideoElement {
    return this.el
  }

  set src(url: string) {
    this.el.src = url
  }

  set poster(url: string | undefined) {
    // 支持清空：早期实现用 `if (url)` 守卫，导致传空值无法移除既有原生封面
    // （`setPoster(undefined)` 这类运行时换封面场景会失效）。
    this.el.poster = url ?? ''
  }

  set muted(m: boolean) {
    this.el.muted = m
    this.el.defaultMuted = m
  }

  get muted(): boolean {
    return this.el.muted
  }

  /** 当前倍速（读回真实生效值，浏览器可能对超范围入参做钳制） */
  get playbackRate(): number {
    return this.el.playbackRate
  }

  set playbackRate(rate: number) {
    this.el.playbackRate = rate
  }

  get currentTime(): number {
    return this.el.currentTime
  }

  get duration(): number {
    return this.el.duration
  }

  /** 定位到指定时间（秒）。调用方负责直播/点播的语义判定与范围钳制。 */
  seek(time: number): void {
    this.el.currentTime = time
  }

  set autoplay(a: boolean) {
    this.el.autoplay = a
  }

  get volume(): number {
    return this.el.volume
  }
  set volume(v: number) {
    this.el.volume = v
  }

  get paused(): boolean {
    return this.el.paused
  }

  play(): Promise<void> {
    return this.el.play()
  }

  pause(): void {
    this.el.pause()
  }

  /**
   * 请求全屏。
   *
   * @param target 期望全屏的元素。缺省为 `<video>`（历史行为）；
   *   传容器元素则做**容器级全屏** —— 自绘控件/默认 UI 控件栏挂在该容器内，
   *   容器全屏后它们仍然可见可点（`<video>` 不能有子元素，全屏 video 会让控件消失）。
   *
   * 选路与 iOS 回退见 `resolveFullscreenPlan`：iOS Safari 不支持普通元素全屏时
   * 自动回退到原生视频全屏（控件不可见，但至少能全屏）。
   */
  requestFullscreen(target?: unknown): void {
    const plan = resolveFullscreenPlan(target as Element | undefined, this.el)
    try {
      switch (plan.api) {
        case 'webkitEnterFullscreen':
          // iOS Safari 内联全屏（不走 Fullscreen API，需用 webkit 私有方法）
          ;(plan.element as FullscreenVideo).webkitEnterFullscreen?.()
          break
        case 'requestFullscreen': {
          // 返回 Promise：被拒绝（非用户手势 / 权限策略）时必须消费，否则抛 unhandledrejection
          const p = (plan.element as FullscreenTarget).requestFullscreen?.()
          void p?.catch(() => undefined)
          break
        }
        case 'webkitRequestFullscreen':
          ;(plan.element as FullscreenTarget).webkitRequestFullscreen?.()
          break
        case 'none':
          break
      }
    } catch {
      /* 老 WebView 同步抛错：全屏非核心能力，静默降级 */
    }
  }

  /**
   * 退出全屏。
   * 需分两条路径：iOS 原生视频全屏（`webkitDisplayingFullscreen`）只能用
   * `video.webkitExitFullscreen()` 退出，`document.exitFullscreen()` 对其无效。
   */
  exitFullscreen(): void {
    const el = this.el as HTMLVideoElement & {
      webkitExitFullscreen?: () => void
      webkitDisplayingFullscreen?: boolean
    }
    const doc = document as Document & {
      webkitExitFullscreen?: () => void
      webkitCancelFullScreen?: () => void
    }
    try {
      if (el.webkitDisplayingFullscreen && el.webkitExitFullscreen) {
        el.webkitExitFullscreen()
        return
      }
      if (doc.exitFullscreen) {
        void doc.exitFullscreen().catch(() => undefined)
      } else if (doc.webkitExitFullscreen) {
        doc.webkitExitFullscreen()
      } else if (doc.webkitCancelFullScreen) {
        doc.webkitCancelFullScreen()
      }
    } catch {
      /* noop */
    }
  }

  /** 当前处于全屏状态的元素（兼容各浏览器前缀），无则 null */
  getFullscreenElement(): Element | null {
    const doc = document as Document & {
      webkitFullscreenElement?: Element | null
      webkitCurrentFullScreenElement?: Element | null
    }
    return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? doc.webkitCurrentFullScreenElement ?? null
  }

  /**
   * 是否处于全屏。除标准 Fullscreen API 外还要认两件事（见 `isPlayerFullscreen`）：
   * - iOS 原生视频全屏（`webkitDisplayingFullscreen`，不体现在 `document.fullscreenElement`）；
   * - **容器级全屏**（`fullscreenElement` 是 `<video>` 的祖先）——
   *   早先只判 `=== this.el`，容器全屏时恒为 false，全屏态不同步。
   */
  isFullscreen(): boolean {
    return isPlayerFullscreen(this.el, this.getFullscreenElement())
  }

  /**
   * 订阅媒体设备事件（`MediaSurface.on`）。
   *
   * Web 侧的特殊之处只有一个：**`fullscreenchange` 要把两个来源合一** ——
   * 标准 Fullscreen API 在 `document` 上派发（含 webkit 前缀事件名），
   * 而 iOS 原生视频全屏走 `<video>` 私有事件且**不派发 fullscreenchange**。
   * 合一之后 core 只认一个事件名，不必知道这些差异。
   */
  on(event: MediaEventName, cb: (data?: unknown) => void): () => void {
    const handler = (): void => cb()
    if (event === 'fullscreenchange') {
      this.el.addEventListener('webkitbeginfullscreen', handler)
      this.el.addEventListener('webkitendfullscreen', handler)
      document.addEventListener('fullscreenchange', handler)
      document.addEventListener('webkitfullscreenchange', handler)
      return () => {
        this.el.removeEventListener('webkitbeginfullscreen', handler)
        this.el.removeEventListener('webkitendfullscreen', handler)
        document.removeEventListener('fullscreenchange', handler)
        document.removeEventListener('webkitfullscreenchange', handler)
      }
    }
    this.el.addEventListener(event, handler)
    return () => this.el.removeEventListener(event, handler)
  }

  /** 媒体错误读数（Web 来自 `MediaError`：1 中止 / 2 网络 / 3 解码 / 4 不支持） */
  error(): { code?: number; message?: string } | null {
    const e = this.el.error
    if (!e) return null
    return { code: e.code, message: e.message }
  }

  /** 已缓冲区间（读 `<video>.buffered`；共用 utils/buffer 的读取逻辑） */
  buffered(): Array<[number, number]> {
    return readBuffers(this.el.buffered)
  }

  /**
   * 该 `<video>` 能否播放给定 MIME（`canPlayType()` 三态收敛为布尔）。
   *
   * 原为 `utils/sniffer.ts` 的 `canPlayNativeHLS` / `canPlayNativeMP4` —— 它们问的是
   * 「**这个媒体设备**能不能播」，属媒体设备能力，故上移到本契约（见 `types.ts#MediaSurface.canPlay`）。
   * `canPlayType` 返回 `''`（不支持）/ `'maybe'` / `'probably'`，非空即视为可播。
   */
  canPlay(type: string): boolean {
    return this.el.canPlayType(type) !== ''
  }

  destroy(): void {
    this.pause()
    this.el.removeAttribute('src')
    try {
      this.el.load()
    } catch {
      /* noop */
    }
    this.el.remove()
  }
}
