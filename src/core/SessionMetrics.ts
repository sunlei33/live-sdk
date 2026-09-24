import type { SessionState } from '../constants'
import type { SessionReport } from '../types'

/**
 * 会话级累计指标 —— `getSessionReport()` 的数据源（`types.ts#SessionReport`）。
 *
 * ── 为什么从 `Player` 抽出来 ──
 *
 * 它自带 7 个字段与一套完整生命周期（清零 / 起记 / 结算 / 读），而**只有 6 个方法碰它** ——
 * 其中 4 个（`report` / 两个 settle / `markFirstFrame`）与 `Player` 的其余状态**零耦合**。
 * 字段—方法引用矩阵里它是那个「孤岛状态簇」，因此是可抽性最高的一块。
 *
 * ── 两段式记录（本模块的核心设计）──
 *
 * 全部量都以「**已结算累计量 + 进行中时段起点**」两段式记录：读的时候把进行中的一段实时补上。
 * 好处是不需要定时器轮询，也不会在暂停/卡顿时把时长算漏。
 *
 * ── 时钟注入 ──
 *
 * `now` 由构造参数注入（默认 `Date.now`）。这样「10 秒窗口边界」这类最易写错的点可以直接断言，
 * 不必等真实时间 —— 与 `Player#lastErrorDedup`（去重窗口）是同一个思路，测试都靠控制时钟。
 */
export class SessionMetrics {
  /** 本轮会话起播时刻（`reset()` 时重置） */
  private loadStartTime: number | null = null
  /** 本轮会话首帧耗时（ms）；出首帧后不再改写，新会话重置为 null */
  private firstFrameCost: number | null = null
  /** 已结算的「实际播放」累计时长（ms） */
  private watchAccum = 0
  /** 进入 playing 的时刻；非 playing 态为 null */
  private watchSince: number | null = null
  /** 已结算的卡顿累计时长（ms） */
  private stallAccum = 0
  /** 进入 stalled 的时刻；非 stalled 态为 null */
  private stallSince: number | null = null
  /** 本轮会话累计卡顿次数 */
  private stallCount = 0

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * 开启新一轮会话。**只由 `play()` 的新一轮起播调用**（会话边界见 `types.ts#SessionReport`）。
   *
   * 这里直接清零而**不先结算**：会话既然要重新开始，旧会话那段进行中的时长本就应该被丢弃；
   * 若先结算再清零等于白算一次，反而容易让人误以为「旧数据被带进新会话」。
   * 读接口 `report()` 自己会补上进行中的一段，所以清零不会造成漏计。
   *
   * ⚠️ 调用时机：**必须在状态机 `transition('load')` 之前** —— `onTransition` 会在状态迁移时
   * 结算「进行中的 playing / stalled 时段」，若先迁移再重置，旧会话的尾巴会被算进新会话。
   */
  reset(): void {
    this.watchAccum = 0
    this.watchSince = null
    this.stallAccum = 0
    this.stallSince = null
    this.stallCount = 0
    this.loadStartTime = this.now()
    this.firstFrameCost = null
  }

  /**
   * 记录本轮会话首帧耗时（幂等：一轮会话只记第一次）。
   *
   * 不依赖 `Player` 的 `firstFrameEmitted` 闸门 —— 那是**一次性**的（兼作「插件可以开始工作」的
   * 就绪信号），二次起播不重置；而首帧耗时**每次起播都要重新计**。两者生命周期不同，必须分开。
   */
  markFirstFrame(): void {
    if (this.firstFrameCost !== null) return
    if (this.loadStartTime === null) return // 未经 play()（如直接操作媒体），无起播基准
    this.firstFrameCost = this.now() - this.loadStartTime
  }

  /**
   * 会话状态迁移钩子：**离开路径统一在这里结算**，而不是只在「恢复」事件里累加。
   *
   * 卡顿并不总以恢复结束 —— 期间可能迁到 `error`（重连）、`ended`（近尾判完）、或被用户 `pause`；
   * 漏了任何一条，那段卡顿时长就永久少计（且很难被发现）。在此集中结算后，
   * 新增任何状态迁移路径都自动被覆盖。播放时长同理。
   *
   * 注意同一时刻**只取一次时钟**（两个 settle 共用），避免两次读钟带来的亚毫秒级错位。
   */
  onTransition(next: SessionState): void {
    const t = this.now()
    this.settleWatch(t)
    this.settleStall(t)
    if (next === 'playing') this.watchSince = t
    if (next === 'stalled') {
      this.stallCount++
      this.stallSince = t
    }
  }

  /**
   * 读会话报告。进行中的时段（正在播放 / 正在卡顿）按「此刻 − 起点」实时计入，
   * 因此返回值是**调用当刻的准确值**，无需等时段结束。
   */
  report(): SessionReport {
    const now = this.now()
    return {
      firstFrameCost: this.firstFrameCost,
      stallCount: this.stallCount,
      stallDuration: this.stallAccum + (this.stallSince !== null ? now - this.stallSince : 0),
      watchTime: this.watchAccum + (this.watchSince !== null ? now - this.watchSince : 0),
      loadStartTime: this.loadStartTime,
    }
  }

  /** 结算进行中的「实际播放」时段（幂等：无进行中时段时为空操作）。 */
  private settleWatch(now: number): void {
    if (this.watchSince === null) return
    this.watchAccum += now - this.watchSince
    this.watchSince = null
  }

  /** 结算进行中的卡顿时段（幂等）。 */
  private settleStall(now: number): void {
    if (this.stallSince === null) return
    this.stallAccum += now - this.stallSince
    this.stallSince = null
  }
}
