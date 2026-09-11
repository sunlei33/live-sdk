import type { Plugin, PluginConstructor, PluginInput } from '../types'
import type { Player } from './Player'
import { logger } from '../utils/logger'

/**
 * PluginManager：插件注册/注销/生命周期调度。
 * 顺序：create（注入 player）→ init（读配置）→ ready（内核就绪后）。
 */
export class PluginManager {
  private plugins = new Map<string, Plugin>()

  constructor(private player: Player) {}

  /**
   * 注册插件。入参**同时接受构造器与实例**（§3.6）：
   * - 构造器：`add(SentryReporter, { sentry })` —— 由 SDK 实例化
   * - 实例：`add(new SentryReporter(), { sentry })` —— 便于业务预先构造/持有引用
   *
   * 两种形态下 SDK 都会调用 `create(player)` 注入播放器、再调用 `init(config)`，
   * 因此业务**不要**在传入实例前自行 `register()`，否则会重复初始化。
   */
  add(input: PluginInput, config?: unknown): Plugin {
    const instance = typeof input === 'function' ? new (input as PluginConstructor)() : input
    const name = instance.name ?? (instance as { constructor?: { name?: string } }).constructor?.name
    if (!name) throw new Error('[plugin] 插件缺少 name，无法注册')
    if (this.plugins.has(name)) {
      logger.warn(`[plugin] 同名插件已存在，跳过：${name}`)
      return this.plugins.get(name)!
    }
    instance.create(this.player)
    instance.init(config)
    this.plugins.set(name, instance)
    // 内核已就绪则立即补调 ready
    if (this.player.kernelReady) {
      try {
        instance.ready()
      } catch (err) {
        logger.error(`[plugin] ready() 异常 ${name}`, err)
      }
    }
    return instance
  }

  remove(name: string): void {
    const instance = this.plugins.get(name)
    if (!instance) return
    try {
      instance.destroy()
    } catch (err) {
      logger.error(`[plugin] destroy() 异常 ${name}`, err)
    }
    this.plugins.delete(name)
  }

  /** 内核就绪后广播 ready */
  readyAll(): void {
    for (const [name, instance] of this.plugins) {
      try {
        instance.ready()
      } catch (err) {
        logger.error(`[plugin] ready() 异常 ${name}`, err)
      }
    }
  }

  /** 按名查找（供上报等内部协作） */
  get<T extends Plugin = Plugin>(name: string): T | undefined {
    return this.plugins.get(name) as T | undefined
  }

  all(): Plugin[] {
    return [...this.plugins.values()]
  }

  destroyAll(): void {
    for (const [name, instance] of this.plugins) {
      try {
        instance.destroy()
      } catch (err) {
        logger.error(`[plugin] destroy() 异常 ${name}`, err)
      }
    }
    this.plugins.clear()
  }
}
