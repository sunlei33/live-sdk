import type { EnvAdapter, NetworkQuality, VisibilityState } from '../types'

/**
 * WebEnvAdapter：纯浏览器默认实现。
 * 前台/后台 = visibilitychange + pagehide；网络 = navigator.onLine；
 * 网络质量用 Network Information API 推断（Safari 不支持则回退二值）。
 */
export class WebEnvAdapter implements EnvAdapter {
  getVisibility(): VisibilityState {
    return document.visibilityState === 'hidden' ? 'background' : 'foreground'
  }

  onVisibilityChange(cb: (v: VisibilityState) => void): () => void {
    const handler = () => cb(this.getVisibility())
    document.addEventListener('visibilitychange', handler)
    window.addEventListener('pagehide', handler)
    return () => {
      document.removeEventListener('visibilitychange', handler)
      window.removeEventListener('pagehide', handler)
    }
  }

  isOnline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine
  }

  onNetworkChange(cb: (online: boolean) => void): () => void {
    const online = () => cb(true)
    const offline = () => cb(false)
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    return () => {
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
    }
  }

  getNetworkQuality(): NetworkQuality {
    const conn = (navigator as Navigator & {
      connection?: { effectiveType?: string; downlink?: number; rtt?: number }
    }).connection
    if (!conn) return this.isOnline() ? 'good' : 'offline'
    const effective = conn.effectiveType ?? ''
    if (effective === 'slow-2g' || effective === '2g') return 'poor'
    if (effective === '3g') return 'fair'
    if ((conn.downlink ?? 0) > 0 && conn.downlink! < 1.5) return 'poor'
    if (conn.downlink! >= 1.5 && conn.downlink! < 5) return 'fair'
    return 'good'
  }
}
