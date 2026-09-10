import { BasePlugin } from '../core/BasePlugin'

/** 直播流状态（服务端下发，映射为事件派发） */
export type LiveStatus = 'not_start' | 'streaming' | 'stuttering' | 'pause' | 'stopped'

/**
 * LivePolling：直播状态轮询插件（§4.6）。
 * 轮询 PlayConfig.liveStatus 接口，状态变化经 `live_status` 事件派发，UI 呈现由接入方决定。
 */
export class LivePolling extends BasePlugin {
  static readonly pluginName = 'livePolling'

  private timer: number | null = null
  private url = ''
  private interval = 25_000
  private lastStatus = ''

  start(url: string, interval?: number): void {
    this.url = url
    if (interval !== undefined) this.interval = interval
    this.stop()
    void this.tick()
    this.timer = window.setInterval(() => void this.tick(), this.interval)
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    try {
      const res = await fetch(this.url)
      const data = (await res.json()) as Record<string, unknown>
      const status = (data.status ?? data.liveStatus ?? data.state ?? '') as string
      if (status && status !== this.lastStatus) {
        this.lastStatus = status
        this.emit('live_status', { status })
      }
    } catch {
      // 轮询失败静默退避，下一轮重试
    }
  }

  destroy(): void {
    this.stop()
    super.destroy()
  }
}
