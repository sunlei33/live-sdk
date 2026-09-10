/**
 * 重连策略的纯函数部分。
 *
 * 抽出来的动机：`Player` 里这段逻辑与 DOM/timer 耦合，单测必须把整台播放器
 * 连同假内核一起搭起来；而它本身是纯计算，抽成纯函数后可以直接断言边界，
 * 也让「防重试风暴」这条设计意图在代码层面有一处可被测试锚定的落点。
 */

/** 默认去重窗口（ms）：同类错误在该窗口内只暴露一次 */
export const ERROR_DEDUP_WINDOW_MS = 10_000

/** 去重状态（由调用方持有，便于多实例隔离） */
export interface DedupState {
  code: string
  time: number
}

/**
 * 同类错误节流去重。
 *
 * 设计意图（勿改）：直播断流往往是「同一故障的连续外化」，内核会成串抛出同类错误。
 * 若逐条透出，接入方的 Sentry 会被同一条错误刷屏，且每一条都会触发一次重连——
 * 这正是「重试风暴」。因此同一 code 在 10s 窗口内只放行第一条。
 *
 * 注意：不同 code 互相不抑制（换了个错误说明故障变了，必须放行）；
 * 窗口外同一 code 再次出现也放行（说明故障复发，需要重新上报）。
 *
 * @param state  上一次放行记录，函数会就地更新（首次调用请传可变对象）
 * @param err    本次错误（只读 code）
 * @param now    当前时间戳（ms），显式传入以便测试注入
 * @returns true 表示「已重复，应抑制」
 */
export function shouldDedupError(state: DedupState, err: { code: string }, now: number): boolean {
  if (state.code === err.code && now - state.time < ERROR_DEDUP_WINDOW_MS) return true
  state.code = err.code
  state.time = now
  return false
}

/**
 * 指数退避 + 抖动。
 *
 * 公式：`base * 2^(n-1) + random() * base`，n 从 1 开始。
 * - `2^(n-1)` 提供指数增长，避免固定间隔在服务端故障时形成共振；
 * - `random() * base` 提供 [0, base) 抖动，打散多端同时重连（惊群）。
 *
 * @param base       基础延迟（ms），来自 config.network.retryDelay
 * @param retryCount 第几次重试（1-based）
 * @param random     随机源，默认 Math.random，测试注入可控值
 */
export function computeRetryDelay(base: number, retryCount: number, random: () => number = Math.random): number {
  return base * Math.pow(2, retryCount - 1) + random() * base
}
