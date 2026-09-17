/**
 * 尺寸判定的**纯函数部分**（服务于「容器零尺寸」接入告警）。
 *
 * 为什么只留这些：`isZeroSized` 是纯判定、零依赖，因此 `core` 可以安全使用；
 * 而**读数**（`readElementSize`：`getBoundingClientRect` / `offsetWidth` 两条回退路径）
 * 读 DOM 全局，已迁到 `src/platform/web/dom.ts`（P1）并由 `HostMount.measure()` 调用。
 * 两者曾同址，会让 core 经 `utils/size` 间接依赖 DOM。
 */

export interface ElementSize {
  width: number
  height: number
}

/**
 * 是否「零尺寸」。**任一维度为 0 就必然看不见画面**——这是「接入后一片空白」最常见的原因：
 * `width/height: 100%` 的容器在父级没有确定高度时高度即为 0。
 *
 * 调用方必须先把「测不到尺寸」（`measure()` 返回 `null`）与「尺寸为 0」区分开：
 * 前者不告警，后者才告警（见 `Player#warnIfZeroSize`）。
 */
export function isZeroSized(size: ElementSize): boolean {
  return size.width <= 0 || size.height <= 0
}

