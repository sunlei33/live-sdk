/** Hooks：内置逻辑的可插拔钩子（before/after，支持异步拦截/增强） */
export type HookFn = (ctx: Record<string, unknown>) => void | Promise<void>

export class Hooks {
  private map = new Map<string, HookFn[]>()

  /** 挂载一个钩子；返回清理函数 */
  use(name: string, fn: HookFn): () => void {
    const list = this.map.get(name) ?? []
    list.push(fn)
    this.map.set(name, list)
    return () => {
      const idx = list.indexOf(fn)
      if (idx >= 0) list.splice(idx, 1)
    }
  }

  /** 顺序执行某个钩子的全部处理器（await 每个） */
  async run(name: string, ctx: Record<string, unknown>): Promise<void> {
    const list = this.map.get(name)
    if (!list) return
    for (const fn of [...list]) {
      await fn(ctx)
    }
  }

  destroy(): void {
    this.map.clear()
  }
}
