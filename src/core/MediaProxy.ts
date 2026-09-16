/**
 * MediaProxy：抽象原生 <video>，抹平浏览器差异（内联播放 / 全屏 / 属性）。
 * 内核创建并持有 video（创建权不开放给接入方），暴露 el 供 hls.js 挂载。
 */
export class MediaProxy {
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

  /** 当前倍速（读回真实生效值，浏览器可能对超范围入参做钳制） */
  get playbackRate(): number {
    return this.el.playbackRate
  }

  set playbackRate(rate: number) {
    this.el.playbackRate = rate
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

  get muted(): boolean {
    return this.el.muted
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

  requestFullscreen(): void {
    const el = this.el as HTMLVideoElement & {
      webkitEnterFullscreen?: () => void
      webkitRequestFullscreen?: () => void
    }
    try {
      if (el.webkitEnterFullscreen) {
        // iOS Safari 内联全屏（不走 Fullscreen API，需用 webkit 私有方法）
        el.webkitEnterFullscreen()
      } else if (el.requestFullscreen) {
        // 返回 Promise：被拒绝（非用户手势 / 权限策略）时必须消费，否则抛 unhandledrejection
        void el.requestFullscreen().catch(() => undefined)
      } else if (el.webkitRequestFullscreen) {
        el.webkitRequestFullscreen()
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
   * 是否处于全屏。除标准 Fullscreen API 外还要认 iOS 原生视频全屏 ——
   * 后者**不体现在 `document.fullscreenElement`**（它由 video 私有状态标记），
   * 只判 API 会在 iOS 上恒为 false，导致全屏态永远不同步、退出按钮无从触发。
   */
  isFullscreen(): boolean {
    const el = this.el as HTMLVideoElement & { webkitDisplayingFullscreen?: boolean }
    if (el.webkitDisplayingFullscreen) return true
    return this.getFullscreenElement() === this.el
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
