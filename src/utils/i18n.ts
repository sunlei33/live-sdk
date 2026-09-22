/**
 * 运行期消息的双语拼接（中文在前、英文在后，以 ` / ` 分隔）。
 *
 * ── 为什么要它 ──
 *
 * SDK 已发布到公开 npm、README 为**中英双语**，但运行期的错误消息与日志此前只有中文：
 * `PlayerError.message`、`logger.warn/error/debug`、上报记录里的 `message` 全是中文，
 * 海外的接入方看不懂，而国内排查的人又需要中文。单字段拼接让**同一条信息同时可读两种语言**。
 *
 * 中文在前的理由：与 README / 文档的双语顺序一致，也与中文日志的既有阅读顺序一致
 * （排查时扫一眼开头就能拿到母语信息，英文作为补充）。
 *
 * ── 为什么不拆成 `message` + `messageEn` 两个字段 ──
 *
 * 那要求消费方**改代码**才能读到另一种语言。而 `message` 本就是给人看的字段 ——
 * 机器可读的部分早就是英文的：`code`（`ERROR_CODE`）、`domain`（`ERROR_DOMAIN`）、
 * `Events.COMMAND` 的 `name`（`COMMAND_NAMES`）。**语言只影响"给人看的那一份"**，
 * 用双字段等于把「读哪种语言」这个显示层选择推给业务，而业务通常只想原样展示/上报。
 *
 * ── 为什么不做成可切换的语言包 ──
 *
 * `PlayerConfig` 目前没有语言配置，加一个会扩大配置面；而错误/日志是**低频、非 UI** 的通道，
 * 双语拼接不会造成噪声（单条消息长一倍，但不影响任何逻辑：没有按 message 做分支的代码，
 * 文档也明确要求**不要**按 message 匹配、要用 `code` / `domain`）。
 *
 * ── 边界 ──
 *
 * 只覆盖**运行期消息**（错误 / 日志 / 上报）。**UI 控件文案不在此列** —— 那是产品文案，
 * 应由接入方按自己的语言策略决定（当前默认 UI 的文案仍是中文；自绘 UI 完全不受影响）。
 *
 * ── 典型用法 ──
 *
 * ```ts
 * logger.warn(`[live-sdk] ${bi('自动播放被拦截，等待用户手势', 'autoplay blocked, waiting for user gesture')}`)
 * this.recover(ERROR_CODE.NETWORK_ERROR, bi('缓冲停滞超时', 'buffer stalled, timed out'))
 * ```
 *
 * ⚠️ **不要嵌套调用**：`bi(a, b)` 的结果若再被 `bi()` 包一次，会得到
 * `中文A / 英文A / 中文B / 英文B` 这种四段式。需要组合时，外层只拼双语一次
 * （见 `Player#recover` 对 `RETRY_EXHAUSTED` 的处理）。
 */
export function bi(zh: string, en: string): string {
  return `${zh} / ${en}`
}
