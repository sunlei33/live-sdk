/**
 * 深层对象合并（配置三层合并：defaultConfig → preset → 用户 config）。
 *
 * 本文件是**纯函数模块**（不读 DOM、不依赖任何层）—— 因此 `core` 可以安全依赖它。
 * 「容器解析」这类读 DOM 的部分已迁到 `src/platform/web/dom.ts`（P1）：
 * 之前两者同址，会让 core 经 `utils/config` 间接依赖 DOM。
 */
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
