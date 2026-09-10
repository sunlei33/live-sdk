import type { EventHandler } from './EventBus'
import type { PluginLifecycle } from '../types'

/**
 * 插件基类：自包含功能单元，有完整生命周期（create/init/ready/destroy）。
 * emit/on 委托到 player 的事件总线，插件间通过共享状态/事件协作，不互相引用。
 */
export abstract class BasePlugin implements PluginLifecycle {
  // 由 PluginManager 注入；使用 definite assignment 断言，避免构造函数里被误用
  player!: import('./Player').Player

  /** 插件名：优先读构造器静态 pluginName，否则用类名 */
  get name(): string {
    const ctor = this.constructor as { pluginName?: string }
    return ctor.pluginName ?? this.constructor.name
  }

  // —— 生命周期（默认空实现，子类按需覆写） ——
  create(player: import('./Player').Player): void {
    this.player = player // 注入 player 引用
  }

  init(_config?: unknown): void {}

  ready(): void {}

  destroy(): void {}

  // —— 动态挂载 / 卸载 ——
  register(player: import('./Player').Player, config?: unknown): void {
    this.player = player
    this.create(player)
    this.init(config)
  }

  unregister(): void {
    this.destroy()
  }

  // —— 事件委托 ——
  emit(event: string, data?: unknown): void {
    this.player.emit(event, data)
  }

  on(event: string, handler: EventHandler): () => void {
    return this.player.on(event, handler)
  }
}
