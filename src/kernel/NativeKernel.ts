import type { BufferInfo, Kernel, KernelCapabilities, KernelOptions, StatsInfo } from '../types'
import { analyzeBuffer, readBuffers } from '../utils/buffer'

/**
 * NativeKernel：Safari / iOS 原生 HLS 回退（video.src 直接播放）。
 * 无 MSE、省电、首帧快；能力受限：无 LL-HLS 可控、无清晰度切换、无深度观测。
 */
export class NativeKernel implements Kernel {
  static readonly kernelName = 'NativeKernel'

  static isSupported(): boolean {
    return true // video 元素始终可用；实际由 canPlayType 判定
  }

  readonly capabilities: KernelCapabilities = {
    lowLatency: false,
    qualitySwitch: false,
    abr: false,
    stats: 'basic',
    nativeFallback: true, // 原生路径：AirPlay / PiP 由浏览器接管，SDK 不承诺
  }

  private opts: KernelOptions

  constructor(opts: KernelOptions) {
    this.opts = opts
  }

  async load(url: string): Promise<void> {
    this.opts.media.src = url
  }

  async switchURL(url: string): Promise<void> {
    this.opts.media.src = url
  }

  switchQuality(_levelIndex: number): void {
    // 原生 HLS 无手动切档能力，空实现
  }

  getStats(): StatsInfo {
    const el = this.opts.media
    return {
      width: el.videoWidth || undefined,
      height: el.videoHeight || undefined,
    }
  }

  bufferInfo(): BufferInfo {
    const el = this.opts.media
    const buffers = readBuffers(el.buffered)
    // 原生无 latency API → behind=0；其余多口径同上（孤岛场景见 BufferInfo 注释）
    return { behind: 0, ...analyzeBuffer(buffers, el.currentTime) }
  }

  recover(): void {
    // 原生恢复：重新加载当前 src
    const el = this.opts.media
    const src = el.currentSrc || el.src
    if (src) {
      el.load()
      void el.play().catch(() => undefined)
    }
  }

  destroy(): void {
    // 原生路径无 object URL，但需清 src 并 load() 中止挂起的网络请求
    // （否则反复 switchURL/destroy 会让旧请求 linger，等效于资源泄漏）。
    const el = this.opts.media
    el.removeAttribute('src')
    try {
      el.load()
    } catch {
      /* noop */
    }
  }
}
