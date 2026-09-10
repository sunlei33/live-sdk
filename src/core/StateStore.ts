import type { PlayerState } from '../types'

/**
 * StateStore：播放器状态快照 + 全量变更订阅（§3.7）。
 * 只保留低频字段（会话/档位/能力）；高频/可观测数据走 getStats/bufferInfo 查询，不进快照。
 */
export class StateStore {
  private state: PlayerState
  private listeners = new Set<(s: PlayerState) => void>()

  constructor(initial: PlayerState) {
    this.state = { ...initial }
  }

  /** 返回快照（浅拷贝，避免外部直接改内部对象） */
  get(): PlayerState {
    return { ...this.state }
  }

  /** 合并补丁并通知全部订阅者（全量快照回调） */
  set(patch: Partial<PlayerState>): void {
    this.state = { ...this.state, ...patch }
    const snapshot = this.get()
    for (const cb of this.listeners) cb(snapshot)
  }

  /** 订阅：任何字段变更都会收到全量快照；返回清理函数 */
  subscribe(cb: (s: PlayerState) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  destroy(): void {
    this.listeners.clear()
  }
}
