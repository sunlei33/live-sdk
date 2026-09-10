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
    if (url) this.el.poster = url
  }

  set muted(m: boolean) {
    this.el.muted = m
    this.el.defaultMuted = m
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
    if (el.webkitEnterFullscreen) {
      // iOS Safari 内联全屏
      el.webkitEnterFullscreen()
    } else if (el.requestFullscreen) {
      el.requestFullscreen()
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen()
    }
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
