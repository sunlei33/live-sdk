/**
 * 环境能力探测（sniffer）。
 * 静态能力探测（MSE / MMS / 原生可播），用于内核选路与前置依赖判定（§7.1）。
 *
 * ── 探测原则：只问能力，不问身份 ──
 *
 * 本模块**不提供 UA 嗅探**。`isIOS` / `isSafari` / `isAndroid` 曾在 0.5.0 及更早版本存在，
 * 已于 0.6.0 删除 —— 因为全仓已无任何 UA 分支，平台差异一律改由能力判定承担
 * （`canPlayType()` / `'MediaSource' in window` / `typeof el.webkitEnterFullscreen === 'function'`，
 * 见 `fullscreen.ts`）。**UA 会骗人，能力不会**：iPadOS 会伪装成 macOS、
 * Chrome/Edge 的 UA 里都含 `Safari`，基于 UA 的分支必然在某个版本上失效。
 * 新增探测项时请沿用这条原则。
 *
 * 同时删除的还有 `supportsH264`（hls.js 的 `Hls.isSupported()` 已覆盖，重复探测无意义）
 * 与 `canAutoplay`（自动播放判定已改由**运行时**承担：`playIntent` + 捕获 `NotAllowedError` 回滚；
 * 预探测反而会误判，因为探测时刻与实际起播时的用户手势状态未必一致）。
 *
 * ── 环境在**调用时**读取 ──
 *
 * 不用模块级 `const hasWindow = ...` 捕获：测试与 SSR 场景下 `window` / `document`
 * 常在模块导入**之后**才就绪，模块级捕获会把值固化成过期状态（这也是本模块长期无单测的原因）。
 */

/** 是否支持标准 MSE */
export function supportsMSE(): boolean {
  return typeof window !== 'undefined' && 'MediaSource' in window
}

/** 是否支持 ManagedMediaSource（iOS 17.1+ / macOS 14.1+ 引入） */
export function supportsManagedMediaSource(): boolean {
  return typeof window !== 'undefined' && 'ManagedMediaSource' in window
}

/** video 元素是否原生可播 HLS（Safari / iOS） */
export function canPlayNativeHLS(video: HTMLVideoElement): boolean {
  return video.canPlayType('application/vnd.apple.mpegurl') !== ''
}

/** 是否原生可播渐进式 MP4（basic 档 <video> 直连路径） */
export function canPlayNativeMP4(video: HTMLVideoElement): boolean {
  return video.canPlayType('video/mp4') !== ''
}
