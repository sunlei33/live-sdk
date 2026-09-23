import type { Plugin, PluginConstructor, PluginInput } from '../types'
import type { Player } from './Player'
import { MSG } from '../constants'
import { logger } from '../utils/logger'
import { t } from '../utils/i18n'

/**
 * PluginManager：插件注册/注销/生命周期调度。
 * 顺序：create（注入 player）→ init（读配置）→ ready（内核就绪后）。
 *
 * ── 职责边界 ──
 *
 * 它管**插件集合**与**生命周期广播**，不管「此刻算不算内核就绪」—— 那是 `Player` 持有的知识。
 * 因此 `add()` 不再自己补调 `ready()`，改由调用方（`Player#addPlugin`）在内核已就绪时显式调 `readyOne()`。
 *
 * ⚠️ 这条边界不是洁癖：本类曾直接读 `player.kernelReady` 来判断，而 TS 的 `private` 是**按类**
 * 封装的（兄弟类也算外部）→ 该字段被迫放弃修饰符 → 泄漏进 `dist` 的 `.d.ts`（`kernelReady: boolean;`，
 * 连 `readonly` 都没有），接入方一行就能伪造「内核已就绪」。现在由 `verify/visibility.mjs` 兜底。
 */
export class PluginManager {
  private plugins = new Map<string, Plugin>()

  constructor(private player: Player) {}

  /**
   * 注册插件。入参**同时接受构造器与实例**（§3.6）：
   * - 构造器：`add(MyReporter, { endpoint })` —— 由 SDK 实例化
   * - 实例：`add(new MyReporter(), { endpoint })` —— 便于业务预先构造/持有引用
   *
   * 两种形态下 SDK 都会调用 `create(player)` 注入播放器、再调用 `init(config)`，
   * 因此业务**不要**在传入实例前自行 `register()`，否则会重复初始化。
   *
   * `ready()` **不在这里调用** —— 内核已就绪时由调用方补调 `readyOne()`（见类注释）。
   */
  add(input: PluginInput, config?: unknown): Plugin {
    const instance = typeof input === 'function' ? new (input as PluginConstructor)() : input
    const name = this.nameOf(instance)
    if (!name) throw new Error(`[plugin] ${t(MSG.PLUGIN_NAME_MISSING)}`)
    if (this.plugins.has(name)) {
      logger.warn(`[plugin] ${t(MSG.PLUGIN_DUPLICATE, { name })}`)
      return this.plugins.get(name)!
    }
    instance.create(this.player)
    instance.init(config)
    this.plugins.set(name, instance)
    return instance
  }

  /** 注销插件：先 `destroy()`（异常只记日志）再从册中移除 */
  remove(name: string): void {
    const instance = this.plugins.get(name)
    if (!instance) return
    try {
      instance.destroy()
    } catch (err) {
      logger.error(`[plugin] ${t(MSG.PLUGIN_DESTROY_THREW, { name })}`, err)
    }
    this.plugins.delete(name)
  }

  /**
   * 给**单个**插件补调 `ready()` —— 供「内核已就绪后才动态注册」的场景。
   *
   * **是否该调由调用方决定**（`Player#addPlugin` 持有 `kernelReady`）：见类注释里
   * 「跨类读取会让字段失去 `private`」那条教训。传进来的实例若不在册则静默跳过。
   */
  readyOne(instance: Plugin): void {
    const name = this.nameOf(instance)
    if (!name || this.plugins.get(name) !== instance) return
    this.invokeReady(name, instance)
  }

  /** 内核就绪后广播 ready */
  readyAll(): void {
    for (const [name, instance] of this.plugins) this.invokeReady(name, instance)
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
        logger.error(`[plugin] ${t(MSG.PLUGIN_DESTROY_THREW, { name })}`, err)
      }
    }
    this.plugins.clear()
  }

  /**
   * 取插件的注册名：优先 `plugin.name`，缺失时回落到构造器名
   * （`registerPlugin(MyReporter)` 这种只传构造器的形态依赖它）。
   */
  private nameOf(instance: Plugin): string | undefined {
    return instance.name ?? (instance as { constructor?: { name?: string } }).constructor?.name
  }

  /** `ready()` 的统一入口：异常只记日志、不打断其它插件（与 `destroyAll` 同一策略） */
  private invokeReady(name: string, instance: Plugin): void {
    try {
      instance.ready()
    } catch (err) {
      logger.error(`[plugin] ${t(MSG.PLUGIN_READY_THREW, { name })}`, err)
    }
  }
}
