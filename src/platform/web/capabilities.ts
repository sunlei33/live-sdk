/**
 * Web 宿主能力探测 + 媒体 MIME 常量。
 *
 * ── 从 `utils/sniffer.ts` 拆分而来 ──
 *
 * 原 `utils/sniffer.ts` 整个模块都是 **Web 平台实现**（`window` 上的能力位 + `video.canPlayType`），
 * 却放在声明为「平台无关纯函数」的 `utils/` 下 —— 而分层门当时的判据是「是否引用 DOM 全局」，
 * 于是它（以及 `fullscreen.ts`）被误判为纯函数，core 引用它也不会报错（见 `verify/layers.mjs`）。
 * 按语义拆成三处：
 *
 * | 原函数 | 去向 | 理由 |
 * |---|---|---|
 * | `supportsMSE` | **本文件** | 宿主能力（`window` 上的能力位），就是平台探测 |
 * | `canPlayNativeHLS` / `canPlayNativeMP4` | **`MediaSurface.canPlay(mime)` 契约** | 它问的是「**这个媒体设备**能不能播」，换宿主时该由宿主自己回答，而不是在平台外拿 Web 语义外推 |
 * | `supportsManagedMediaSource` | **删除** | 唯一用途是给 hls.js 设 `preferManagedMediaSource`，而 hls.js 对该项自带可用性降级 —— 恒传 `true` 与探测等价（依据见 `kernel/HlsKernel.ts` 的注释）。删掉它，内核就不需要任何平台能力探测 |
 *
 * ── 探测原则（沿用原文件）──
 *
 * **只问能力，不问身份**：不做 UA 嗅探。`isIOS` / `isSafari` / `isAndroid` / `supportsH264` /
 * `canAutoplay` 已在 0.6.0 删除 —— UA 会骗人，能力不会。
 *
 * 环境在**调用时**读取，不做模块级捕获：测试与 SSR 场景下 `window` 常在模块导入**之后**才就绪，
 * 模块级捕获会把值固化成过期状态（这正是原模块长期无单测的原因）。
 */

/** 播放 HLS（m3u8）的 MIME。 */
export const MIME_HLS = 'application/vnd.apple.mpegurl'

/** 渐进式 MP4 的 MIME（`observability: 'basic'` 档的 `<video>` 直连路径）。 */
export const MIME_MP4 = 'video/mp4'

/** 是否支持标准 MSE（MediaSource Extensions）。 */
export function supportsMSE(): boolean {
  return typeof window !== 'undefined' && 'MediaSource' in window
}
