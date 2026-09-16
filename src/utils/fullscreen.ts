/**
 * 全屏目标与 API 选路的纯函数（与 DOM 解耦，便于单测）。
 *
 * 为什么需要「选路」：全屏有三种互不兼容的实现，且**同一次请求可能落到不同元素**——
 * - `<video>.webkitEnterFullscreen()`：iOS 原生视频全屏，**不走 Fullscreen API**
 *   （`document.fullscreenElement` 不反映它，只能读 `video.webkitDisplayingFullscreen`）；
 * - `Element.requestFullscreen()`：标准 Fullscreen API（桌面 Chrome/Edge/Firefox、Android）；
 * - `Element.webkitRequestFullscreen()`：旧 WebKit 前缀。
 *
 * 业务诉求（TODO-9）：自绘控件挂在容器里而非 `<video>` 内（`<video>` 不能有子元素），
 * 若只全屏 `<video>`，控件在全屏后不可见 → 需要能**指定全屏目标**（容器级）。
 */

/** 全屏可用的原生 API 形态（按优先级） */
export type FullscreenApi =
  | 'webkitEnterFullscreen' // iOS 原生视频全屏（仅 <video> 私有，不走 Fullscreen API）
  | 'requestFullscreen' // 标准 Fullscreen API
  | 'webkitRequestFullscreen' // WebKit 前缀
  | 'none' // 该环境不支持任何全屏

export interface FullscreenPlan {
  /** 实际请求全屏的元素（可能与传入 target 不同——见 iOS 回退） */
  element: Element
  api: FullscreenApi
}

/**
 * 带标准 / 前缀全屏方法的结构类型。
 * `webkitRequestFullscreen` 不在 lib.dom 里，故用结构化声明而非 `any`。
 */
export type FullscreenTarget = Element & {
  requestFullscreen?: (options?: unknown) => Promise<void>
  webkitRequestFullscreen?: () => void
}

/** `<video>` 的 iOS 私有全屏方法（同样不在 lib.dom 里） */
export type FullscreenVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void
  webkitDisplayingFullscreen?: boolean
}

const asTarget = (el: Element) => el as FullscreenTarget
const asVideo = (el: HTMLVideoElement) => el as FullscreenVideo

/**
 * 决定「对哪个元素、用哪个 API」请求全屏。
 *
 * 优先级：
 * 1. 目标是 `<video>` 且有 `webkitEnterFullscreen` → iOS 原生视频全屏（兼容性最好）
 * 2. 目标有标准 `requestFullscreen` → 标准 API
 * 3. 目标有 `webkitRequestFullscreen` → 前缀 API
 * 4. **目标（如容器）在此环境不支持元素全屏（iOS Safari）→ 回退原生视频全屏**，
 *    保证「至少能全屏」；代价是自绘控件在全屏内不可见（系统性限制，非本 SDK 可解）
 * 5. 都不支持 → `api: 'none'`（调用方静默降级，全屏非核心能力）
 *
 * @param target 期望全屏的元素；缺省为 `<video>` 自身（保持既有行为）
 * @param video  播放器的 `<video>` 元素（回退目标）
 */
export function resolveFullscreenPlan(target: Element | undefined, video: HTMLVideoElement): FullscreenPlan {
  const el = asTarget(target ?? video)
  const vid = asVideo(video)
  if (el === vid && typeof vid.webkitEnterFullscreen === 'function') {
    return { element: video, api: 'webkitEnterFullscreen' }
  }
  if (typeof el.requestFullscreen === 'function') return { element: el, api: 'requestFullscreen' }
  if (typeof el.webkitRequestFullscreen === 'function') return { element: el, api: 'webkitRequestFullscreen' }
  if (typeof vid.webkitEnterFullscreen === 'function') {
    return { element: video, api: 'webkitEnterFullscreen' }
  }
  return { element: el, api: 'none' }
}

/**
 * 判定「播放器是否处于全屏」。
 *
 * 两个必须覆盖的来源：
 * 1. **iOS 原生视频全屏**：不出现在 `fullscreenElement` 里，只能读 `video.webkitDisplayingFullscreen`；
 * 2. **容器级全屏**：`fullscreenElement` 是 `<video>` 的**祖先**（业务的容器 / SDK 的 `root`）。
 *    早先实现只判 `fullscreenElement === video`，导致「容器全屏后 SDK 全然不知」——
 *    `PlayerState.fullscreen` 恒 false，全屏按钮图标不切换、再点也退不出来。
 *
 * 采用「祖先链」判定而非记录「上次请求的元素」：业务可能**不经过 SDK** 自行对容器请求全屏
 * （README §4.4 的绕过方案正是如此），记录法会漏判。
 *
 * 副作用：若接入方把更外层（如整个应用外壳）全屏，本判定也会为 true——此时视频确实占满屏幕，
 * 认定为全屏并允许一键退出，符合用户预期。
 */
export function isPlayerFullscreen(video: HTMLVideoElement, fullscreenElement: Element | null): boolean {
  const vid = asVideo(video)
  if (vid.webkitDisplayingFullscreen) return true
  if (!fullscreenElement) return false
  return fullscreenElement === video || fullscreenElement.contains(video)
}
