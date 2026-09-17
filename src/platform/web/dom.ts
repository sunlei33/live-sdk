/**
 * Web 专属的 DOM 读操作：容器解析与尺寸测量。
 *
 * 这两个函数由 `utils/{config,size}.ts` 迁移而来（P1），**原因只有一个**：
 * 它们读了 DOM 全局（`document.querySelector` / `getBoundingClientRect`），
 * 留在 `utils/` 会让 `core` 通过 `utils` 间接依赖 DOM。
 *
 * 迁移后：
 * - `utils/config.ts` 只剩纯函数 `deepMerge`；`utils/size.ts` 只剩纯判定 `isZeroSized`；
 * - 本文件归属 Web 平台，`core` 不再引用；
 * - **公开 API 不变**：`readElementSize` / `resolveContainer` 仍从 `@fancaf/live-sdk` 顶层导出
 *   （`src/index.ts` 是装配层，负责再导出）。
 *
 * 这正是 `verify/layers.mjs` 想要的结构：**纯的留下、读平台的搬走**，
 * 于是「core 是否依赖了平台」可以按"模块是否读 DOM"自动判定，无需人工维护白名单。
 */

export interface ElementSize {
  width: number
  height: number
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

/**
 * 读取元素的盒子尺寸。**环境无法测量时返回 `null`**。
 *
 * 优先 `getBoundingClientRect()`（亚像素精度、含 transform 效果），
 * 回退 `offsetWidth` / `offsetHeight`（整数且**向下取整**——0.5px 的容器会读成 0，
 * 故仅在 rect 不可用时才用）。
 *
 * `null` 与「尺寸为 0」必须严格区分：非浏览器环境、自建 DOM 替身、元素未挂载时，
 * 这些属性都不存在；若把它们当成 0，测试与 SSR 场景会满屏误报警告。
 */
export function readElementSize(el: Element | null | undefined): ElementSize | null {
  if (!el) return null

  const withRect = el as Element & { getBoundingClientRect?: () => unknown }
  if (typeof withRect.getBoundingClientRect === 'function') {
    try {
      const r = withRect.getBoundingClientRect() as { width?: unknown; height?: unknown } | undefined
      if (r && typeof r.width === 'number' && typeof r.height === 'number') {
        return { width: r.width, height: r.height }
      }
    } catch {
      /* 部分宿主（老 WebView / 已卸载元素）会抛，继续走 offset 回退 */
    }
  }

  const off = el as Element & { offsetWidth?: unknown; offsetHeight?: unknown }
  if (typeof off.offsetWidth === 'number' && typeof off.offsetHeight === 'number') {
    return { width: off.offsetWidth, height: off.offsetHeight }
  }

  return null
}
