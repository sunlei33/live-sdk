/** 事件发布订阅：统一事件常量（Events）+ 回调注册，避免魔法字符串 */
import { MSG } from '../constants'
import { t } from '../utils/i18n'

export type EventHandler = (data?: unknown) => void

export class EventBus {
  private map = new Map<string, Set<EventHandler>>()

  on(event: string, handler: EventHandler): () => void {
    let set = this.map.get(event)
    if (!set) {
      set = new Set()
      this.map.set(event, set)
    }
    set.add(handler)
    return () => this.off(event, handler)
  }

  once(event: string, handler: EventHandler): () => void {
    const wrapper: EventHandler = (data) => {
      this.off(event, wrapper)
      handler(data)
    }
    return this.on(event, wrapper)
  }

  off(event: string, handler?: EventHandler): void {
    if (!handler) {
      this.map.delete(event)
      return
    }
    this.map.get(event)?.delete(handler)
  }

  emit(event: string, data?: unknown): void {
    const set = this.map.get(event)
    if (!set) return
    // 拷贝一份，避免回调内增删监听器影响本轮遍历
    for (const handler of [...set]) {
      try {
        handler(data)
      } catch (err) {
        // 监听器异常不阻断其它监听器，也不抛给接入方
        // eslint-disable-next-line no-console
        console.error('[live-sdk]', t(MSG.EVENT_HANDLER_THREW, { event }), err)
      }
    }
  }

  removeAll(): void {
    this.map.clear()
  }
}
