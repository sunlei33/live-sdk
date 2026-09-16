import type { SessionState } from '../constants'

/** 状态机事件名（驱动状态表） */
export type StateMachineEvent =
  | 'load'
  | 'manifestParsed'
  | 'play'
  | 'pause'
  | 'stall'
  | 'recovered'
  | 'timeout'
  | 'error'
  | 'retry'
  | 'ended'

/**
 * 显式状态表驱动的播放状态机（§3.3）。
 * 各状态间网状流转，非单一路径；副作用（起播/重连/清定时器）由 Player 监听状态变化驱动。
 */
export class StateMachine {
  private state: SessionState = 'idle'
  private listeners = new Set<(next: SessionState, prev: SessionState) => void>()

  private table: Record<SessionState, Partial<Record<StateMachineEvent, SessionState>>> = {
    idle: { load: 'loading' },
    loading: { manifestParsed: 'ready', error: 'error' },
    ready: { play: 'playing' },
    playing: { pause: 'paused', stall: 'stalled', ended: 'ended', error: 'error' },
    paused: { play: 'playing', ended: 'ended' },
    // stalled → ended：近尾卡顿且 buffer 已到末尾时，语义是「播完」而非「停滞待重连」
    // （部分内核如 Android WebView 解码器会近尾停推，但内容已放完）。
    // stalled → paused：卡顿期间用户按下暂停。这条边必须显式存在 —— 否则迁移失败后
    // 只靠 `onMediaPause` 的兜底分支翻转 `playing`，状态机会**停在 stalled**，
    // 既让 `sessionState` 与事实不符（用户在暂停，却报「卡顿中」），
    // 又会让「进行中的卡顿时长」永远得不到结算（少计）。
    stalled: { recovered: 'playing', pause: 'paused', timeout: 'error', ended: 'ended' },
    error: { retry: 'loading', ended: 'ended' },
    ended: { play: 'playing', load: 'loading' },
  }

  get current(): SessionState {
    return this.state
  }

  /** 该事件在当前态下是否可迁移 */
  can(event: StateMachineEvent): boolean {
    return this.table[this.state]?.[event] !== undefined
  }

  /** 迁移；成功返回 true 并通知监听器 */
  transition(event: StateMachineEvent): boolean {
    const next = this.table[this.state]?.[event]
    if (!next) return false
    const prev = this.state
    this.state = next
    for (const cb of this.listeners) cb(next, prev)
    return true
  }

  reset(): void {
    this.state = 'idle'
  }

  onChange(cb: (next: SessionState, prev: SessionState) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
}
