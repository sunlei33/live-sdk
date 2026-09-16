/**
 * 容器尺寸检测（服务于「容器零尺寸」接入告警）。
 *
 * 抽成纯函数的原因同 `errors.ts`：`getBoundingClientRect` / `offsetWidth` 两条回退路径
 * 加上「环境无法测量」这一态，分支不少，留在 `Player` 里等于没有单测覆盖。
 */

export interface ElementSize {
  width: number
  height: number
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

/**
 * 是否「零尺寸」。**任一维度为 0 就必然看不见画面**——这是「接入后一片空白」最常见的原因：
 * `width/height: 100%` 的容器在父级没有确定高度时高度即为 0。
 */
export function isZeroSized(size: ElementSize): boolean {
  return size.width <= 0 || size.height <= 0
}
