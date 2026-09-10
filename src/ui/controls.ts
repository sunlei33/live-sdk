import type { Player } from '../core/Player'
import { UIPlugin, bindPress } from './UIPlugin'

/** 播放/暂停按钮 */
export class PlayButton extends UIPlugin {
  private btn!: HTMLButtonElement
  mount(root: HTMLElement, player: Player): void {
    this.btn = document.createElement('button')
    this.btn.className = 'live-sdk-btn'
    root.appendChild(this.btn)
    this.unsub = player.subscribe((s) => {
      this.btn.textContent = s.playing ? '⏸' : '▶'
    })
    // Pointer Events 单一事件源（见 bindPress 注释：规避 click+touch 双触发、触摸大屏无响应）
    this.track(
      bindPress(this.btn, () => {
        // 以媒体真实暂停态为切换判据（快照可能与浏览器异步事件存在一帧延迟）；
        // play() 返回 Promise：显式消费，避免 unhandledrejection（可恢复错误已由 SDK 内部重连）
        if (!player.media.paused) {
          player.pause()
        } else {
          void player.play().catch(() => {})
        }
      }),
    )
  }
  unmount(): void {
    this.disposeAll()
    this.unsub?.()
    this.btn?.remove()
  }
}

/** 静音切换 */
export class MuteButton extends UIPlugin {
  private btn!: HTMLButtonElement
  mount(root: HTMLElement, player: Player): void {
    this.btn = document.createElement('button')
    this.btn.className = 'live-sdk-btn'
    root.appendChild(this.btn)
    this.unsub = player.subscribe((s) => {
      this.btn.textContent = s.muted ? '🔇' : '🔊'
    })
    this.track(
      bindPress(this.btn, () => {
        const s = player.getState()
        player.mute(!s.muted)
      }),
    )
  }
  unmount(): void {
    this.disposeAll()
    this.unsub?.()
    this.btn?.remove()
  }
}

/** 音量滑块（与静音状态联动：拖到 0 即静音，静音中拖动即恢复出声） */
export class VolumeControl extends UIPlugin {
  private slider!: HTMLInputElement
  mount(root: HTMLElement, player: Player): void {
    this.slider = document.createElement('input')
    this.slider.type = 'range'
    this.slider.min = '0'
    this.slider.max = '1'
    this.slider.step = '0.05'
    this.slider.className = 'live-sdk-volume'
    Object.assign(this.slider.style, {
      width: '80px',
      verticalAlign: 'middle',
      // 触摸大屏/移动端：允许浏览器把水平手势交给滑块，避免被页面滚动吞掉
      touchAction: 'pan-y',
    })
    root.appendChild(this.slider)

    this.unsub = player.subscribe((s) => {
      // 静音时滑块归零，但记住原音量供恢复
      this.slider.value = String(s.muted ? 0 : s.volume)
    })

    // range 控件的 input 事件在鼠标/触摸/Pointer 下均会触发，无需自行绑定指针事件，
    // 也不会像 click+touchend 那样双触发。此处仅消费其值。
    const onInput = () => {
      const v = Number(this.slider.value)
      player.setVolume(v)
      // 静音中拖动 → 视为恢复出声
      if (player.getState().muted && v > 0) player.mute(false)
    }
    this.slider.addEventListener('input', onInput)
    this.track(() => this.slider.removeEventListener('input', onInput))
  }
  unmount(): void {
    this.disposeAll()
    this.unsub?.()
    this.slider?.remove()
  }
}

/** 清晰度面板（下拉选择；无档位时隐藏） */
export class QualityPanel extends UIPlugin {
  private select!: HTMLSelectElement
  mount(root: HTMLElement, player: Player): void {
    this.select = document.createElement('select')
    this.select.className = 'live-sdk-select'
    root.appendChild(this.select)
    this.unsub = player.subscribe((s) => {
      if (!s.capabilities.qualitySwitch || s.qualities.length === 0) {
        this.select.style.display = 'none'
        return
      }
      this.select.style.display = ''
      const current = s.currentQuality
      this.select.innerHTML = `<option value="-1">自动</option>` + s.qualities
        .map((q) => `<option value="${q.id}">${q.label ?? q.id}</option>`)
        .join('')
      this.select.value = String(current ?? -1)
    })
    const onChange = () => player.switchQuality(Number(this.select.value))
    this.select.addEventListener('change', onChange)
    this.track(() => this.select.removeEventListener('change', onChange))
  }
  unmount(): void {
    this.disposeAll()
    this.unsub?.()
    this.select?.remove()
  }
}

/** 全屏按钮 */
export class FullscreenButton extends UIPlugin {
  private btn!: HTMLButtonElement
  mount(root: HTMLElement, player: Player): void {
    this.btn = document.createElement('button')
    this.btn.className = 'live-sdk-btn'
    this.btn.textContent = '⛶'
    root.appendChild(this.btn)
    this.track(bindPress(this.btn, () => player.requestFullscreen()))
  }
  unmount(): void {
    this.disposeAll()
    this.btn?.remove()
  }
}
