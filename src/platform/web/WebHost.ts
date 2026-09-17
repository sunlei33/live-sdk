/**
 * Web 承载面实现：DOM 根节点、容器解析、尺寸测量、封面图层。
 *
 * 由 `core/Player` 的构造期代码迁移而来（P1）。搬过来的四件事性质相同 ——
 * **它们都只在"有 DOM 的宿主"里才有意义**：
 * 1. 创建 root `div` 并挂到容器（含 `string | HTMLElement` 解析）；
 * 2. 给 root 与 media 写布局样式（relative / absolute inset 0 / 100%）；
 * 3. 测尺寸（`readElementSize`，服务于零尺寸告警）；
 * 4. overlay 模式的封面图层（`<img>`，MSE 路径下原生 poster 不可靠）。
 *
 * 归属说明：core 只通过 `HostMount` 契约使用它，**不知道 DOM 的存在**。
 */
import type { HostMount } from '../../types'
import { resolveContainer, readElementSize } from './dom'

export class WebHost implements HostMount<HTMLElement> {
  readonly root: HTMLDivElement = document.createElement('div')

  private posterEl: HTMLImageElement | null = null
  private mounted = false

  constructor() {
    this.root.style.position = 'relative'
    this.root.style.width = '100%'
    this.root.style.height = '100%'
  }

  /** `container` 支持选择器字符串或元素本体（解析失败抛错，与迁移前行为一致）。 */
  mount(container: unknown, media: unknown): void {
    const host = resolveContainer(container as string | HTMLElement)

    const el = media as HTMLVideoElement
    el.style.position = 'absolute'
    el.style.inset = '0'
    el.style.width = '100%'
    el.style.height = '100%'

    this.root.appendChild(el)
    host.appendChild(this.root)
    this.mounted = true
  }

  measure(): { width: number; height: number } | null {
    return readElementSize(this.root)
  }

  /**
   * 显示封面图层（懒建）。
   * z-index 低于默认控件层（`UIMount` 的 controls bar 为 z-index:10），不遮挡操作。
   */
  showPosterOverlay(src: string): void {
    const el = this.ensurePosterEl()
    el.src = src
    el.style.display = 'block'
  }

  /** 隐藏封面图层（幂等）。首帧呈现、进入播放时调用。 */
  hidePosterOverlay(): void {
    if (this.posterEl) this.posterEl.style.display = 'none'
  }

  destroy(): void {
    this.posterEl?.remove()
    this.posterEl = null
    if (this.mounted) this.root.remove()
    this.mounted = false
  }

  private ensurePosterEl(): HTMLImageElement {
    if (this.posterEl) return this.posterEl
    const el = document.createElement('img')
    el.className = 'live-sdk-poster'
    Object.assign(el.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      display: 'none',
      zIndex: '1',
    })
    el.setAttribute('alt', '')
    this.root.appendChild(el)
    this.posterEl = el
    return el
  }
}
