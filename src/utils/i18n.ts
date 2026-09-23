import { DEFAULT_LOCALE, MSG, type MsgId } from '../constants'
import type { Locale } from '../types'
import { MESSAGES } from './messages'

/**
 * 运行期消息（含 UI 控件文案）的语言设置与取文案入口。
 *
 * ── 形态 ──
 *
 * 每条消息有一个**稳定编号**（`constants.ts#MSG`，形如 `LV-3004`）与**中英两套文案**
 * （`utils/messages.ts`）。按当前 locale 取一种，有**两个入口**，按受众区分：
 *
 * | 入口 | 返回 | 受众 | 用在 |
 * |---|---|---|---|
 * | `t(id, params)` | `[LV-3004] 文案` | 开发 / 排查 | 错误、日志、上报记录 |
 * | `uiText(id, params)` | `文案` | 终端用户 | UI 的 `title` / `aria-label` / 下拉项 |
 *
 * 两者共用**同一张文案表**与**同一个 locale** —— 因此 **UI 控件文案继承
 * `PlayerConfig.locale`**，业务不需要也不该为 UI 再传一次语言。
 *
 * ── 为什么编号随消息一起输出（仅 `t`）──
 *
 * 文案会随**语言**和**版本**变化，编号不变：用户报障可直接引用 `[LV-3004]`，文档与排查手册
 * 按编号索引，接入方的告警规则也能锚定编号 —— 不必再依赖易变的 message 文本
 * （历史上 message 从中文 → 「中文 / English」→ 单语编号化，已经变过两次）。
 *
 * ── 为什么 UI 文案**不**带编号 ──
 *
 * 编号是给**开发引用**的。tooltip 与 `aria-label` 面向终端用户，出现 `[LV-7002]` 只是噪声，
 * 还挤占按钮上有限的空间；无障碍朗读也会把编号逐字念出来。所以受众不同、形态不同。
 *
 * ── locale 是**全局单例**语义（与 `setLogLevel` 同类）──
 *
 * 由 `new Player(...)` 构造时按 `PlayerConfig.locale` 写入。因此**同一页面多个 Player 实例
 * 共用最后一次设置的语言** —— 与日志级别完全一致的行为（两者都是进程级的显示偏好）。
 * 需要按实例区分语言时，请消费与语言无关的数据：`PlayerError.code`、`ERROR_DOMAIN`、`MSG` 编号。
 * ⚠️ **UI 也在这个语义内**：多个实例各挂一套控件时，两边文案都会跟随最后一次 `locale`。
 *
 * ── 运行中切换语言 ──
 *
 * `setLocale()` 会通知订阅者（`onLocaleChange`），UI 控件据此用**最近状态立即重绘**文案。
 * 没有这层通知的话，`player.subscribe` 只在**状态变化**时触发，会出现「语言变了、tooltip 没变」
 * 的窗口（甚至长期停在旧语言）。订阅方务必解绑 —— `ui/UIPlugin.ts#bindState` 已自动处理。
 *
 * ── 为什么默认英文 ──
 *
 * SDK 发布在公开 npm、README 为中英双语，日志与错误首先面向更广的读者；中文使用方显式传
 * `locale: 'zh'` 即可（一行配置）。
 */
let currentLocale: Locale = DEFAULT_LOCALE

/** locale 变更订阅者（UI 控件注册，见 `ui/UIPlugin.ts#bindState`） */
const localeListeners = new Set<() => void>()

/**
 * 设置语言。
 *
 * **幂等**：与当前值相同时直接返回、不触发通知 —— 否则多个 Player 实例以同一 locale 构造
 * 会引发一轮无谓的 UI 重绘。
 */
export function setLocale(locale: Locale): void {
  if (locale === currentLocale) return
  currentLocale = locale
  for (const fn of localeListeners) {
    try {
      fn()
    } catch (err) {
      // 与 EventBus 同理：一个订阅者的异常不得让 setLocale 抛出 ——
      // 它是在 `new Player()` 构造里被调用的，抛出会让**构造直接失败**，
      // 代价（拿不到播放器）远大于收益（一个控件文案没刷新）。
      console.error(t(MSG.LOCALE_LISTENER_THREW, { detail: String(err) }))
    }
  }
}

export function getLocale(): Locale {
  return currentLocale
}

/**
 * 订阅语言变更，返回解绑函数。
 *
 * 供 UI 重绘使用。**务必解绑**（`ui/UIPlugin.ts` 通过 `track()` 在 unmount 时自动解绑），
 * 否则已卸载的控件会被这个集合长期持有。
 */
export function onLocaleChange(fn: () => void): () => void {
  localeListeners.add(fn)
  return () => {
    localeListeners.delete(fn)
  }
}

/**
 * 取消息：`[LV-xxxx] <当前语言的文案>`。
 *
 * `params` 用于插值 `{name}` 占位符；**未提供的占位符原样保留**（便于一眼看出漏传参数，
 * 而不是静默变成 `undefined`）。
 */
export function t(id: MsgId, params?: Record<string, string | number>): string {
  return `[${id}] ${pick(id, params)}`
}

/**
 * 取 **UI 控件文案**：纯文案，**不带编号**。
 *
 * 面向终端用户（`title` / `aria-label` / 下拉项），与 `t()` 共用同一张文案表与同一个 locale；
 * 唯一差别就是没有编号前缀。**不要**拿它输出错误或日志 —— 那些需要编号以便引用与索引。
 */
export function uiText(id: MsgId, params?: Record<string, string | number>): string {
  return pick(id, params)
}

/** 按当前 locale 取文案并插值（`t` 与 `uiText` 的公共实现） */
function pick(id: MsgId, params?: Record<string, string | number>): string {
  const entry = MESSAGES[id]
  // 理论上不可达（`Record<MsgId, …>` 已穷尽），兜底成编号本身 —— 绝不让日志因缺文案而抛错
  const text = entry ? entry[currentLocale] : id
  return interpolate(text, params)
}

function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (matched, key: string) =>
    key in params ? String(params[key]) : matched,
  )
}
