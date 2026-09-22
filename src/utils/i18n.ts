import { DEFAULT_LOCALE, type MsgId } from '../constants'
import type { Locale } from '../types'
import { MESSAGES } from './messages'

/**
 * 运行期消息的语言设置与取文案入口。
 *
 * ── 形态 ──
 *
 * 每条消息有一个**稳定编号**（`constants.ts#MSG`，形如 `LV-3004`）与**中英两套文案**
 * （`utils/messages.ts`）。`t(id, params)` 按当前 locale 取一种，返回 `[LV-3004] 文案`。
 *
 * ── 为什么要编号，且编号随消息一起输出 ──
 *
 * 文案会随**语言**和**版本**变化，编号不变：用户报障可直接引用 `[LV-3004]`，文档与排查手册
 * 按编号索引，接入方的告警规则也能锚定编号 —— 不必再依赖易变的 message 文本
 * （历史上 message 从中文 → 「中文 / English」→ 单语编号化，已经变过两次）。
 *
 * ── locale 是**全局单例**语义（与 `setLogLevel` 同类）──
 *
 * 由 `new Player(...)` 构造时按 `PlayerConfig.locale` 写入。因此**同一页面多个 Player 实例
 * 共用最后一次设置的语言** —— 与日志级别完全一致的行为（两者都是进程级的显示偏好）。
 * 需要按实例区分语言时，请消费与语言无关的数据：`PlayerError.code`、`ERROR_DOMAIN`、`MSG` 编号。
 *
 * ── 为什么默认英文 ──
 *
 * SDK 发布在公开 npm、README 为中英双语，日志与错误首先面向更广的读者；中文使用方显式传
 * `locale: 'zh'` 即可（一行配置）。**UI 控件文案不在此机制内**（属产品文案，见 README「消息语言」）。
 */
let currentLocale: Locale = DEFAULT_LOCALE

export function setLocale(locale: Locale): void {
  currentLocale = locale
}

export function getLocale(): Locale {
  return currentLocale
}

/**
 * 取文案：`[LV-xxxx] <当前语言的文案>`。
 *
 * `params` 用于插值 `{name}` 占位符；**未提供的占位符原样保留**（便于一眼看出漏传参数，
 * 而不是静默变成 `undefined`）。
 */
export function t(id: MsgId, params?: Record<string, string | number>): string {
  const entry = MESSAGES[id]
  // 理论上不可达（`Record<MsgId, …>` 已穷尽），兜底成编号本身 —— 绝不让日志因缺文案而抛错
  const text = entry ? entry[currentLocale] : id
  return `[${id}] ${interpolate(text, params)}`
}

function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (matched, key: string) =>
    key in params ? String(params[key]) : matched,
  )
}
