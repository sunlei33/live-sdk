/**
 * 环境能力探测（sniffer）。
 * 静态能力探测（MSE / 原生 HLS / 平台），用于内核选路与前置依赖判定（§7.1）。
 */

const UA = typeof navigator !== 'undefined' ? navigator.userAgent : ''
const hasWindow = typeof window !== 'undefined'

export function isIOS(): boolean {
  if (!hasWindow) return false
  const platform = navigator.platform || ''
  const maxTouchPoints = navigator.maxTouchPoints || 0
  return /iPad|iPhone|iPod/.test(UA) || (platform === 'MacIntel' && maxTouchPoints > 1)
}

export function isSafari(): boolean {
  if (!hasWindow) return false
  const vendor = navigator.vendor || ''
  return /Safari/.test(UA) && !/Chrome|Chromium|CriOS|Edge|Edg\//.test(UA) && vendor.includes('Apple')
}

export function isAndroid(): boolean {
  return /Android/i.test(UA)
}

/** 是否支持标准 MSE */
export function supportsMSE(): boolean {
  return hasWindow && 'MediaSource' in window
}

/** 是否支持 ManagedMediaSource（iOS 17.1+ / macOS 14.1+ 引入） */
export function supportsManagedMediaSource(): boolean {
  return hasWindow && 'ManagedMediaSource' in window
}

/** video 元素是否原生可播 HLS（Safari / iOS） */
export function canPlayNativeHLS(video: HTMLVideoElement): boolean {
  return video.canPlayType('application/vnd.apple.mpegurl') !== ''
}

/** 是否原生可播渐进式 MP4（basic 档 <video> 直连路径） */
export function canPlayNativeMP4(video: HTMLVideoElement): boolean {
  return video.canPlayType('video/mp4') !== ''
}

/** 是否支持 H.264 分片（hls.js 主路径前提之一） */
export function supportsH264(): boolean {
  if (!hasWindow) return false
  const v = document.createElement('video')
  return v.canPlayType('video/mp4; codecs="avc1.42E01E"') !== ''
}

/** 自动播放探测：返回 Promise，resolve = 可自动播放 */
export function canAutoplay(muted: boolean): Promise<boolean> {
  if (!hasWindow) return Promise.resolve(false)
  const video = document.createElement('video')
  video.muted = muted
  video.setAttribute('playsinline', '')
  const p = video.play()
  if (p !== undefined) {
    return p.then(
      () => true,
      () => false,
    )
  }
  return Promise.resolve(false)
}
