import type { Player } from '../core/Player'
import type { PlayerState } from '../types'
import { onLocaleChange } from '../utils/i18n'

/**
 * 统一的「按下」事件绑定：**只用 Pointer Events 单一事件源**。
 *
 * 为什么不用 click / touchstart：
 * - click + touchend 双绑定会让一次点击触发两次（旋转/切换类控件单次点击会连转两下）。
 * - 部分触摸大屏只派发 Pointer Events、不派发兼容的 mouse/touch 事件，
 *   绑 click 会导致按下无响应（触摸大屏进度条拖不动）。
 * - Pointer Events 是 W3C 统一模型，鼠标 / 触摸 / 触控笔一套代码全覆盖。
 *
 * 同时用 `pointerdown` 而非 `pointerup`，避免与内部控件的默认拖拽产生竞态；
 * 对按钮类控件而言按下即触发符合直觉。返回解绑函数，供 unmount 清理。
 */
export function bindPress(el: HTMLElement, handler: (ev: PointerEvent) => void): () => void {
  const onPointerDown = (ev: PointerEvent) => {
    // 仅响应主指针（忽略多指，避免双触发）
    if (ev.isPrimary === false) return
    handler(ev)
  }
  el.addEventListener('pointerdown', onPointerDown)
  return () => el.removeEventListener('pointerdown', onPointerDown)
}

/**
 * UIPlugin：UI 插件基类 =「订阅状态 → 渲染 DOM → 监听交互 → 调用命令」的自包含单元。
 * 只通过两条通道连接内核：subscribe 拿状态、player 命令方法做控制，别无耦合（§3.7）。
 */
export abstract class UIPlugin {
  abstract mount(root: HTMLElement, player: Player): void
  abstract unmount(): void
  protected unsub?: () => void
  /** 事件解绑器集合（mount 时收集，unmount 时统一清理，避免重复绑定/内存泄漏） */
  protected disposers: Array<() => void> = []

  /** 供子类注册清理函数；unmount 时由基类兜底调用 */
  protected track(dispose: () => void): void {
    this.disposers.push(dispose)
  }

  /**
   * 订阅状态并**记住最近一次快照**（`unsub` 由基类持有，子类在 `unmount` 里释放）。
   *
   * 三件事：
   * 1. **mount 时立即用 `player.getState()` 画一次** —— 不依赖 `subscribe` 是否同步回调
   *    （否则图标/文案要等第一次状态变化才出现）；
   * 2. 之后每次状态变化重绘；
   * 3. 额外注册「语言变更 → 用最近快照重绘」。
   *
   * 第 3 条是关键：`subscribe` 只在**状态变化**时触发，而 `setLocale()` 不改状态 ——
   * 若接入方在运行中切语言，光靠订阅会让已挂载的控件停在旧语言（tooltip 是中文、
   * 新日志却是英文），且可能长期不刷新。语言变更通知补上了这个窗口。
   *
   * 订阅与监听都由 `track()` 登记，`unmount()` 时一并解除，不会泄漏。
   * 无文案的控件（如音量滑块）也走这里 —— 结构统一，将来补文案不必再改绑定方式。
   */
  protected bindState(player: Player, render: (s: PlayerState) => void): void {
    let last: PlayerState | null = null
    const paint = (s: PlayerState) => {
      last = s
      render(s)
    }
    paint(player.getState())
    this.unsub = player.subscribe(paint)
    this.track(
      onLocaleChange(() => {
        if (last) render(last)
      }),
    )
  }

  /** 子类 unmount 末尾调用，统一解绑 */
  protected disposeAll(): void {
    for (const d of this.disposers) d()
    this.disposers = []
  }
}
