import Hls from 'hls.js'
import type { BufferInfo, Kernel, KernelCapabilities, KernelOptions, LevelInfo, StatsInfo } from '../types'
import { analyzeBuffer, readBuffers } from '../utils/buffer'
import { logger } from '../utils/logger'

/**
 * HlsKernel：hls.js 封装（fMP4 解封装，LL-HLS / ABR / 清晰度切换 / 错误恢复）。
 * iOS 17.1+ 经 preferManagedMediaSource 走 MMS。
 */
export class HlsKernel implements Kernel {
  static readonly kernelName = 'HlsKernel'

  static isSupported(): boolean {
    return Hls.isSupported()
  }

  readonly capabilities: KernelCapabilities
  private hls: Hls | null = null
  private opts: KernelOptions
  private currentUrl = ''
  // 下载速率统计（FRAG_LOADED 累计，简单滑动平均）
  private speedAccum = 0
  private speedCount = 0
  /**
   * 当前 level 的 playlist 是否仍在直播（无 `#EXT-X-ENDLIST`）。
   *
   * 初值取 `true`，与 hls.js `LevelDetails.live` 的默认值一致（`loader/level-details.ts:24`）。
   * **换源时刻意不重置**：新源解析出 `live` 前保持旧值，避免「VOD → VOD」换源时产生
   * 一次无意义的 `true → false` 抖动；代价是从「点播源换到直播源」时会有一个很短的窗口
   * 仍报非直播（此时 `duration` 也还是旧值，属同一瞬态）。
   */
  private liveFlag = true

  constructor(opts: KernelOptions) {
    this.opts = opts
    this.capabilities = {
      lowLatency: true,
      qualitySwitch: true,
      abr: true,
      stats: opts.observability === 'full' ? 'full' : 'basic',
      // MSE 路径：AirPlay 需经 <source> 挂载才能与 MSE 共存（hls.js mseAttachMode 同理），
      // 否则 MSE 接管 <video>.src 后系统投屏按钮会消失。
      nativeFallback: false,
    }
  }

  async load(url: string): Promise<void> {
    this.currentUrl = url
    this.ensureHls()
    this.hls!.loadSource(url)
  }

  async switchURL(url: string): Promise<void> {
    this.currentUrl = url
    this.ensureHls()
    // hls.js 无「无缝换源」原生能力，重新 loadSource 触发新 manifest 解析。
    // 若上一源尚未 attach 完成（不在 sourceopen 态），直接 loadSource 会遗留旧 MediaSource
    // 与其 object URL。这里先释放上一源再挂新源，保证一对一回收。
    if (this.hls!.media && (this.hls!.media as HTMLVideoElement).src?.startsWith('blob:')) {
      this.releaseMediaSourceUrl()
      this.hls!.attachMedia(this.opts.media)
    }
    this.hls!.loadSource(url)
  }

  switchQuality(levelIndex: number): void {
    if (!this.hls) return
    this.hls.currentLevel = levelIndex // -1 恢复自动（ABR）
  }

  getLevels(): LevelInfo[] {
    if (!this.hls) return []
    return this.hls.levels.map((level, index) => ({
      index,
      height: level.height || 0,
      bitrate: level.bitrate || 0,
    }))
  }

  getCurrentLevel(): number {
    return this.hls?.currentLevel ?? -1
  }

  getStats(): StatsInfo {
    const hls = this.hls
    const level = hls && hls.currentLevel >= 0 ? hls.levels[hls.currentLevel] : undefined
    const media = this.opts.media
    const quality = (media as HTMLVideoElement & { getVideoPlaybackQuality?: () => { droppedVideoFrames: number } })
    return {
      bitrate: level?.bitrate,
      width: level?.width || media.videoWidth || undefined,
      height: level?.height || media.videoHeight || undefined,
      videoCodec: level?.videoCodec,
      fps: level?.attrs?.FRAME_RATE ? parseFloat(level.attrs.FRAME_RATE) : undefined,
      speed: this.speedAccum,
      avgSpeed: this.speedCount > 0 ? this.speedAccum : 0,
      droppedVideoFrames: quality.getVideoPlaybackQuality?.().droppedVideoFrames,
    }
  }

  bufferInfo(): BufferInfo {
    const el = this.opts.media
    const buffers = readBuffers(el.buffered)
    const behind = this.hls?.latency ?? 0
    // 多口径：当前播放块 vs 全部区间并集（孤岛场景下二者会分歧，见 BufferInfo 注释）
    return { behind, ...analyzeBuffer(buffers, el.currentTime) }
  }

  recover(): void {
    this.hls?.startLoad()
  }

  setLiveLatency(target: number, max: number): void {
    const hls = this.hls
    if (!hls) return
    // targetLatency 为 hls.js 官方 setter；maxLatency 经 liveMaxLatencyDuration 透传
    try {
      hls.targetLatency = target
    } catch {
      /* 老版本回退 */
    }
    hls.config.liveMaxLatencyDuration = max
  }

  /**
   * playlist 是否仍在直播 —— 见 `Kernel.isLive?()`。
   *
   * core 用它替代「`duration` 是否有限」的推断：hls.js 默认 `liveDurationInfinity: false`
   * 会把**直播流**的 `MediaSource.duration` 写成有限的 playlist edge，
   * 于是直播与点播在 `duration` 上无法区分。
   */
  isLive(): boolean {
    return this.liveFlag
  }

  destroy(): void {
    // 关键：hls.destroy() 会 detachMedia → revoke 内部 object URL → 关闭 MediaSource。
    // 但若 attachMedia 尚未走到 sourceopen（如刚 loadSource 就被 destroy），
    // 旧 MediaSource 的 sourceopen 回调可能仍持有旧 video 引用（与 attach 未完成同源的问题）。
    // 这里显式 detach + 清空，确保 object URL 与 MediaSource 被回收，且不再有迟到回调操作已销毁的 <video>。
    if (this.hls) {
      try {
        this.hls.detachMedia()
      } catch {
        /* detach 失败不阻断销毁 */
      }
      this.hls.destroy()
      this.hls = null
    }
    // 兜底：清理 video 上可能残留的 blob src（部分浏览器 destroy 后仍保留）
    this.releaseMediaSourceUrl()
  }

  /**
   * 释放 `<video>` 上由 MSE 产生的 blob: object URL。
   * hls.js 正常路径会自行 revoke；此处仅作兜底，避免反复 switchURL/destroy 累积泄漏。
   */
  private releaseMediaSourceUrl(): void {
    const el = this.opts.media
    const src = el.src || ''
    if (src.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(src)
      } catch {
        /* noop */
      }
      el.removeAttribute('src')
      try {
        el.load()
      } catch {
        /* noop */
      }
    }
  }

  private ensureHls(): void {
    if (this.hls) return
    const config: Record<string, unknown> = {
      lowLatencyMode: true,
      // 恒取 true，**不做平台能力探测** —— hls.js 自己会对该偏好做可用性降级：
      //   const mms = (prefer || !self.MediaSource) && self.ManagedMediaSource
      //   return mms || self.MediaSource || self.WebKitMediaSource
      // 即「prefer」与「ManagedMediaSource 存在」是 **AND** 关系，MMS 不存在时自动落回标准 MSE。
      // 因此 `true` 与「探测到 MMS 才传 true」在所有组合下等价（hls.js 1.7.2 源码核实）；
      // 而 hls.js 自己的 config 默认值是 `false`（见其 `hlsDefaultConfig`），所以这一项不能省。
      // 好处：内核不再需要任何平台能力探测 → 不必反向依赖平台实现层（见 verify/layers.mjs）。
      // 仍可被 `hlsConfig.preferManagedMediaSource` 覆盖（展开在最后）。
      preferManagedMediaSource: true,
      ...this.opts.hlsConfig,
    }
    const hls = new Hls(config as never)
    this.hls = hls
    hls.attachMedia(this.opts.media)

    hls.on(Hls.Events.MANIFEST_PARSED, (_evt, data) => {
      this.opts.onEvent('manifest_parsed', data)
    })
    hls.on(Hls.Events.LEVELS_UPDATED, () => {
      this.opts.onEvent('levels_updated', this.getLevels())
    })
    // `details.live` = playlist 里还没有 `#EXT-X-ENDLIST`，是 hls.js 自己的权威判据
    // （它据此决定把 MediaSource.duration 写成 Infinity 还是 playlist edge）。
    // 注意监听的是 **LEVEL_UPDATED（单数）**，payload `{ details, level, drift }`；
    // 隔壁 LEVELS_UPDATED（复数）只带 `{ levels }`，拿不到 details。
    hls.on(Hls.Events.LEVEL_UPDATED, (_evt, data) => {
      const live = data.details.live
      // 直播期间该事件随 playlist 重载**周期性触发**（数秒一次）→ 必须去重，
      // 只在真正翻转时派发（与 `live_status` 同一取向：不变化不通知）。
      if (live === this.liveFlag) return
      this.liveFlag = live
      this.opts.onEvent('live_changed', { live })
    })
    hls.on(Hls.Events.LEVEL_SWITCHED, (_evt, data) => {
      this.opts.onEvent('level_switched', { level: data.level })
    })
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      this.opts.onEvent('error', data)
    })
    if (this.opts.observability === 'full') {
      hls.on(Hls.Events.FRAG_LOADED, (_evt, data) => {
        // 下载速率：字节 * 8 / 加载耗时
        const duration = data.frag.stats ? data.frag.stats.loading.end - data.frag.stats.loading.start : 0
        if (duration > 0) {
          const bytes = data.frag.stats.total || data.payload?.byteLength || 0
          const speed = (bytes * 8) / (duration / 1000)
          this.speedAccum = this.speedCount === 0 ? speed : this.speedAccum * 0.7 + speed * 0.3
          this.speedCount++
        }
        this.opts.onEvent('frag_loaded', data)
      })
    }
    logger.debug(`[HlsKernel] created, url=${this.currentUrl}`)
  }
}
