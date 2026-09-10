/** 深层对象合并（配置三层合并：defaultConfig → preset → 用户 config） */
export function deepMerge<T extends object>(...sources: Array<Partial<T> | undefined>): T {
  const result: Record<string, unknown> = {}
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue
    for (const key of Object.keys(source)) {
      const value = (source as Record<string, unknown>)[key]
      if (value === undefined) continue
      if (isPlainObject(value) && isPlainObject(result[key])) {
        result[key] = deepMerge(result[key] as Record<string, unknown>, value as Record<string, unknown>)
      } else if (Array.isArray(value)) {
        result[key] = value.slice()
      } else {
        result[key] = value
      }
    }
  }
  return result as T
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 把配置里的容器选择器解析为元素（string → querySelector） */
export function resolveContainer(container: string | HTMLElement): HTMLElement {
  if (typeof container === 'string') {
    const el = document.querySelector<HTMLElement>(container)
    if (!el) throw new Error(`[live-sdk] container 未找到：${container}`)
    return el
  }
  return container
}
