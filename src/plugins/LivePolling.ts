import { BasePlugin } from '../core/BasePlugin'
import { logger } from '../utils/logger'
import type { LiveStatusErrorPayload, LiveStatusPayload } from '../types'

/** 直播流状态（服务端下发，映射为事件派发） */
export type LiveStatus = 'not_start' | 'streaming' | 'stuttering' | 'pause' | 'stopped'

/**
 * 「轮询失败」事件名：`player.on(LIVE_STATUS_ERROR_EVENT, cb)`。
 *
 * 与 `live_status` 一样是**独立事件名、不进 `Events` 枚举** —— 理由见
 * `LiveStatusErrorPayload` 的注释（旁路能力、不与播放错误通道混流）。
 * 导出常量是为了让接入方不必手写字符串字面量（写错字符串只会静默收不到回调）。
 */
export const LIVE_STATUS_ERROR_EVENT = 'live_status_error'

/** 默认轮询间隔（ms），即 `start(url)` 第二参数缺省时使用的值 */
const DEFAULT_INTERVAL = 25_000

/** 默认退避上限（ms）：连续失败时最长 5 分钟问一次 */
const DEFAULT_MAX_INTERVAL = 300_000

/**
 * LivePolling：直播状态轮询插件（§4.6）。
 * 轮询 `PlayConfig.liveStatus` 接口，状态**发生变化**时经 `live_status` 事件派发
 * 结构化 payload（见 `LiveStatusPayload`），UI 呈现由接入方决定。
 *
 * 为什么只在变化时派发：状态是低频、幂等的事实，去重可避免订阅方反复重渲染；
 * 需要心跳语义请直接读最近一次 payload（或自行加定时器）。
 *
 * ── 失败语义（v0.3.0 修复）──────────────────────────────────────────────────
 * 轮询是**旁路能力**：任何失败都不得影响播放、不得触发重连。但「不打扰」不等于
 * 「悄悄死掉」—— 早期实现是空 `catch {}`，接入方无法区分下面这两种截然不同的处境：
 *   · 轮询正常，服务端状态确实没变（预期行为）；
 *   · 轮询已经持续失败、实际上已经死了（故障）。
 * 二者在业务侧的观感完全一样（「状态一直没变」），后者会让人相信一个错误的事实。
 * 因此现在：
 *   · 每次失败都走 `logger.warn`（不节流，日志本就是给人排查用的）；
 *   · 失败还经 `live_status_error` 事件外抛，并按连续次数节流（见 `shouldReportFailure`）；
 *   · 连续失败按指数退避拉长请求间隔（成功一次立即复位），既不放弃、也不撞墙。
 */
export class LivePolling extends BasePlugin {
  static readonly pluginName = 'livePolling'

  /**
   * 退避间隔上限（ms），默认 5 分钟。可在 `start()` 之前改写
   * （`polling.maxInterval = 60_000`）。只影响**连续失败**时的间隔；
   * 正常轮询恒为 `interval`。
   */
  maxInterval = DEFAULT_MAX_INTERVAL

  /** 待执行的下一轮句柄（正常间隔或退避等待，二者共用同一个句柄） */
  private timer: number | null = null
  private url = ''
  private baseInterval = DEFAULT_INTERVAL
  private lastStatus = ''
  /** 连续失败次数（成功即归零），退避倍数与事件节流都基于它 */
  private failCount = 0
  /** 上一轮请求是否仍在途（并发保护，见 `tick()`） */
  private inFlight = false
  /**
   * 轮询「代号」：每次 `start()` / `stop()` 自增。
   * 用途：在途请求返回时它所属的轮次可能已被废弃（如后台暂停、重新 start），
   * 若不做校验，旧回调会在 `stop()` 之后**自己把定时器续上** —— 表现为
   * 「已经停了却还在请求」，且再也停不掉。
   */
  private generation = 0

  start(url: string, interval?: number): void {
    this.url = url
    if (interval !== undefined) this.baseInterval = interval
    this.stop() // 会刷新 generation，使在途旧轮次失效
    this.failCount = 0 // 显式 start = 一次新的开始，退避与计数复位
    void this.tick()
  }

  stop(): void {
    this.generation++
    if (this.timer !== null) {
      window.clearTimeout(this.timer)
      this.timer = null
    }
  }

  /**
   * 失败事件是否应当外抛（节流判据）。
   *
   * 第 1 次必须外抛（故障要立刻可见）；其后取 3、10 与每满 30 次（30 / 60 / 90…），
   * 兼顾「持续故障仍有心跳式信号」与「长时间断网不刷屏」。
   * 抽成静态纯函数是为了让这条判据可以被单测直接锚定（含边界）。
   */
  static shouldReportFailure(failCount: number): boolean {
    return failCount === 1 || failCount === 3 || failCount === 10 || (failCount >= 30 && failCount % 30 === 0)
  }

  private async tick(): Promise<void> {
    const gen = this.generation

    // 并发保护：退避用的是「上一轮结束后再排下一轮」的串行 setTimeout，
    // 本身已不会重叠；唯一能撞上的路径是「上一轮请求还没回来时又被 start() 拉起」。
    // 此时跳过本轮，但**仍要排下一轮** —— 不能因为一次跳过就让轮询链彻底断掉。
    if (this.inFlight) {
      this.scheduleNext(gen)
      return
    }

    this.inFlight = true
    type Outcome = { ok: true; status: string; raw: Record<string, unknown> } | { ok: false; error: string }
    let outcome: Outcome
    try {
      const res = await fetch(this.url)
      if (!res.ok) {
        // `fetch` 对 4xx/5xx **不 reject**（只有网络层失败才 reject），所以必须自行
        // 校验 `res.ok`。否则最常见的故障形态 —— 「500 + JSON 错误体」—— 会
        // 既不进 catch、又取不到状态字段，变成连痕迹都没有的静默失败。
        outcome = { ok: false, error: `HTTP ${res.status}` }
      } else {
        const raw = (await res.json()) as Record<string, unknown>
        const status = normalizeStatus(raw)
        outcome = status
          ? { ok: true, status, raw }
          : { ok: false, error: '响应缺少可识别的状态字段（status / liveStatus / state）' }
      }
    } catch (err) {
      outcome = { ok: false, error: (err as Error)?.message || String(err) }
    } finally {
      this.inFlight = false
    }

    // 本轮已被 `stop()` 或新的 `start()` 取代 → **整轮作废**：既不派发结果
    // （它可能来自上一个 url，混进新会话会给出错误的直播状态），也不续排
    // （否则会留下一条引用旧 url 的野定时器，且再也停不掉）。
    if (gen !== this.generation) return

    if (outcome.ok) {
      this.failCount = 0 // 一次成功即归零，退避随之复位
      if (outcome.status !== this.lastStatus) {
        const payload: LiveStatusPayload = {
          status: outcome.status,
          previousStatus: this.lastStatus,
          raw: outcome.raw, // 服务端原始响应透传：业务自定义字段（主播信息、预计恢复时间）可直接取用
          time: Date.now(),
        }
        this.lastStatus = outcome.status
        this.emit('live_status', payload)
      }
    } else {
      this.reportFailure(outcome.error)
    }

    this.scheduleNext(gen)
  }

  /**
   * 排下一轮。**用 `setTimeout` 串联，而不是 `setInterval`**：
   * 固定间隔在连续失败时会形成「每 25s 无脑撞一次墙」，这里的间隔按
   * `base * 2^failCount` 指数退避、上限 `maxInterval`；成功一次即复位为 `base`。
   * 串行排程同时顺带消除了「单次请求慢于间隔」导致的多轮重叠。
   */
  private scheduleNext(gen: number): void {
    const delay =
      this.failCount === 0
        ? this.baseInterval
        : Math.min(this.baseInterval * 2 ** this.failCount, this.maxInterval)
    this.timer = window.setTimeout(() => {
      this.timer = null
      if (gen !== this.generation) return
      void this.tick()
    }, delay)
  }

  /** 记录一次失败：日志全量输出，事件按节流输出。 */
  private reportFailure(error: string): void {
    this.failCount++
    logger.warn(`[live-sdk] 直播状态轮询失败（连续 ${this.failCount} 次，${error}）：${this.url}`)
    if (!LivePolling.shouldReportFailure(this.failCount)) return
    const payload: LiveStatusErrorPayload = {
      url: this.url,
      failCount: this.failCount,
      error,
      time: Date.now(),
    }
    this.emit(LIVE_STATUS_ERROR_EVENT, payload)
  }

  destroy(): void {
    this.stop()
    super.destroy()
  }
}

/**
 * 归一服务端状态值。
 *
 * 必须显式 `String()` 而非 `as string` 断言 —— 断言只影响类型、不改运行时值。
 * 若服务端下发 `{"status": 0}`（数字 0），`lastStatus` 是字符串、新值是数字，
 * `status === this.lastStatus` 恒为 `false` → **每一轮都被判为「状态变化」并派发**，
 * 去重机制整体失效（订阅方被高频重渲染，接入方还会以为状态在反复跳变）。
 *
 * 空值（`null` / `undefined` / 空串 / 纯空白）返回空串，由调用方按「无可识别状态」当作失败处理。
 */
function normalizeStatus(raw: Record<string, unknown>): string {
  const v = raw.status ?? raw.liveStatus ?? raw.state
  if (v === null || v === undefined) return ''
  return String(v).trim()
}
