import type { Player } from '../core/Player'
import { MSG } from '../constants'
import { uiText } from '../utils/i18n'
import { UIPlugin, bindPress } from './UIPlugin'

/**
 * 内置控件的文案统一走 `uiText()`（继承 `PlayerConfig.locale`，**不带 `[LV-xxxx]` 编号**）。
 *
 * 三点约定：
 * 1. **动作式文案**：按钮提示写「点了会怎样」（全屏态下是 `退出全屏`、静音态下是 `取消静音`），
 *    而不是描述当前状态 —— 与图标语义一致，用户不必反推。
 * 2. **图标按钮必须有可访问名**：`⏸` / `🔊` 这类字符对读屏软件没有语义（读出来是空白或符号名），
 *    所以每个按钮都补 `title` + `aria-label`（两者同文案：前者是悬停提示，后者是读屏名）。
 * 3. **状态与文案同一处渲染**：`bindState()` 在 mount 时立即画一次、状态变化时重绘、
 *    语言变更时用最近快照重绘，三者的渲染逻辑是同一段代码，不会各写一份而漂移。
 */

/** 播放/暂停按钮 */
export class PlayButton extends UIPlugin {
  private btn!: HTMLButtonElement
  mount(root: HTMLElement, player: Player): void {
    this.btn = document.createElement('button')
    this.btn.className = 'live-sdk-btn'
    root.appendChild(this.btn)
    this.bindState(player, (s) => {
      this.btn.textContent = s.playing ? '⏸' : '▶'
      const label = uiText(s.playing ? MSG.UI_PAUSE : MSG.UI_PLAY)
      this.btn.title = label
      this.btn.setAttribute('aria-label', label)
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
    this.bindState(player, (s) => {
      this.btn.textContent = s.muted ? '🔇' : '🔊'
      const label = uiText(s.muted ? MSG.UI_UNMUTE : MSG.UI_MUTE)
      this.btn.title = label
      this.btn.setAttribute('aria-label', label)
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

    this.bindState(player, (s) => {
      // 静音时滑块归零，但记住原音量供恢复
      this.slider.value = String(s.muted ? 0 : s.volume)
      // 只给 `aria-label`，不给 `title`：滑块每拖一下都弹 tooltip 是噪声
      this.slider.setAttribute('aria-label', uiText(MSG.UI_VOLUME))
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

/**
 * 建一个 `<option>`：**DOM API 而非 HTML 字符串**。
 *
 * `q.label` 是业务可控字符串（业务常从接口取档位名，再经 `PlayConfig.quality` 传进来），
 * 用 `innerHTML = \`<option>${label}</option>\`` 拼接就是一个注入点 ——
 * 形如 `<img src=x onerror=…>` 的标签名会被解析执行。
 * `textContent` / `value` 属性赋值都**不解析标记**，从根上消除该风险。
 */
function makeOption(value: string, label: string): HTMLOptionElement {
  const opt = document.createElement('option')
  opt.value = value
  opt.textContent = label
  return opt
}

/** 清晰度面板（下拉选择；无档位时隐藏） */
export class QualityPanel extends UIPlugin {
  private select!: HTMLSelectElement
  mount(root: HTMLElement, player: Player): void {
    this.select = document.createElement('select')
    this.select.className = 'live-sdk-select'
    root.appendChild(this.select)
    this.bindState(player, (s) => {
      if (!s.capabilities.qualitySwitch || s.qualities.length === 0) {
        this.select.style.display = 'none'
        return
      }
      this.select.style.display = ''
      const current = s.currentQuality
      // ⚠️ **不要改回 `innerHTML` 字符串拼接** —— 见 `makeOption` 的注释：
      // `q.label` 业务可控，拼进 HTML 等于开一个注入点。
      this.select.replaceChildren(
        makeOption('-1', uiText(MSG.UI_QUALITY_AUTO)),
        ...s.qualities.map((q) => makeOption(String(q.id), q.label ?? String(q.id))),
      )
      this.select.value = String(current ?? -1)
    })
    // `switchQuality` 返回 Promise（内部 await before 钩子），语句式触发即可 —— 失败会走 ERROR 通道
    const onChange = () => void player.switchQuality(Number(this.select.value))
    this.select.addEventListener('change', onChange)
    this.track(() => this.select.removeEventListener('change', onChange))
  }
  unmount(): void {
    this.disposeAll()
    this.unsub?.()
    this.select?.remove()
  }
}

/** 全屏切换按钮（图标与点击方向都随 `PlayerState.fullscreen` 变化） */
export class FullscreenButton extends UIPlugin {
  private btn!: HTMLButtonElement
  mount(root: HTMLElement, player: Player): void {
    this.btn = document.createElement('button')
    this.btn.className = 'live-sdk-btn'
    root.appendChild(this.btn)
    this.bindState(player, (s) => {
      // 进入/退出共用一枚按钮：全屏态换成「还原」图标并同步提示文案
      this.btn.textContent = s.fullscreen ? '⧉' : '⛶'
      const label = uiText(s.fullscreen ? MSG.UI_FULLSCREEN_EXIT : MSG.UI_FULLSCREEN_ENTER)
      this.btn.title = label
      this.btn.setAttribute('aria-label', label)
    })
    this.track(
      bindPress(this.btn, () => {
        // 以快照的全屏态决定方向——早期实现只会 requestFullscreen()，
        // 全屏后按钮再点无效（用户被困在全屏，只能靠系统 Esc/手势退出）。
        if (player.getState().fullscreen) player.exitFullscreen()
        // 全屏 player.root（容器级）而非 <video>：控件栏挂在 root 内，
        // 只全屏 <video> 会让控件栏在全屏后消失（自相矛盾）。
        // iOS 无元素全屏能力时由 SDK 内部回退原生视频全屏。
        else player.requestFullscreen(player.root)
      }),
    )
  }
  unmount(): void {
    this.disposeAll()
    this.unsub?.()
    this.btn?.remove()
  }
}
