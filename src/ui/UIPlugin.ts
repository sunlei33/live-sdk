import type { Player } from '../core/Player'

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

  /** 子类 unmount 末尾调用，统一解绑 */
  protected disposeAll(): void {
    for (const d of this.disposers) d()
    this.disposers = []
  }
}
