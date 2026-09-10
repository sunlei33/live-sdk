import type { Player } from '../core/Player'
import type { UIPlugin } from './UIPlugin'
import { PlayButton, MuteButton, VolumeControl, QualityPanel, FullscreenButton } from './controls'

export { UIPlugin, bindPress } from './UIPlugin'
export { PlayButton, MuteButton, VolumeControl, QualityPanel, FullscreenButton } from './controls'

export interface UIMountOptions {
  plugins: Array<new () => UIPlugin>
  target?: HTMLElement // 默认 player.root
}

/** UIMount：装配一组 UIPlugin（增删 UI = 增删数组元素） */
export class UIMount {
  private instances: UIPlugin[] = []
  private bar!: HTMLDivElement
  private disposed = false

  constructor(private player: Player, private opts: UIMountOptions) {}

  mount(): void {
    const target = this.opts.target ?? this.player.root
    this.bar = document.createElement('div')
    this.bar.className = 'live-sdk-controls'
    Object.assign(this.bar.style, {
      position: 'absolute',
      left: '0',
      right: '0',
      bottom: '0',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '8px',
      background: 'rgba(0,0,0,0.5)',
      zIndex: '10',
    })
    target.appendChild(this.bar)
    for (const Ctor of this.opts.plugins) {
      const inst = new Ctor()
      inst.mount(this.bar, this.player)
      this.instances.push(inst)
    }
    // 随内核销毁自动卸载
    this.player.onDestroy(() => this.unmount())
  }

  unmount(): void {
    if (this.disposed) return
    this.disposed = true
    for (const inst of this.instances) inst.unmount()
    this.instances = []
    this.bar?.remove()
  }
}

/** 一键挂载默认控件层：播放/暂停、静音、音量、清晰度、全屏（§3.7 开箱即用） */
export function mountDefaultUI(player: Player): UIMount {
  const mount = new UIMount(player, {
    plugins: [PlayButton, MuteButton, VolumeControl, QualityPanel, FullscreenButton],
    target: player.root,
  })
  mount.mount()
  return mount
}
