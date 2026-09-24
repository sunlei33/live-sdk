import { DEFAULT_LOCALE, MSG, type MsgId } from '../constants'
import type { Locale } from '../types'

/**
 * 运行期消息（含 UI 控件文案）的语言设置与取文案入口。
 *
 * ── 形态 ──
 *
 * 每条消息有一个**稳定编号**（`constants.ts#MSG`，形如 `LV-3004`）与**中英两套文案**
 * （本文件底部的 `MESSAGES`）。按当前 locale 取一种，有**两个入口**，按受众区分：
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

/**
 * 运行期消息文案表：编号 → `{ en, zh }`。
 *
 * **单一事实源**：所有面向人的消息（错误 / 日志 / 上报 / `FeatureStatus.detail` /
 * `zeroSizeHint` / 接入方可见的 `throw`）**以及 UI 控件文案**都从这里取，
 * 模块里**不再出现裸字符串**（含 `ui/` —— UI 文案同样走这张表，不再硬编码）。
 * 这样加一条消息只需两步：① 在 `constants.ts#MSG` 登记编号；② 在**本文件底部**补中英文。
 *
 * **类型即完整性校验**：`Record<MsgId, …>` 是穷尽映射 —— 登记了编号却忘了补文案，
 * TypeScript 直接编译失败（比「运行时才发现某条消息是 undefined」早得多）。
 * 上面那两个取用入口（`t` / `uiText`）就是它**唯二的消费者**。
 *
 * **不导出（0.6.0）**：它是实现细节 —— 取文案请经 `t()` / `uiText()`。
 * 这样「文案怎么存」与「文案怎么取」不会各自漂移，也避免接入方绕过编号直接读表
 * （编号才是给外部锚定的那一样东西，见 `constants.ts#MSG`）。
 *
 * **占位符**：用 `{name}`，由上面的 `interpolate()` 插值；
 * 未提供对应参数时占位符**原样保留**（`{name}`），便于一眼看出漏传。
 *
 * ⚠️ **编号与文案是两件事**：文案随 `PlayerConfig.locale` 与版本变化，编号恒定。
 * 接入方要锚定某条消息，请锚 `[LV-xxxx]` 编号，**不要**锚文案文本。
 *
 * ── 为什么与 `i18n.ts` 同一个文件（原为 `utils/messages.ts`）──
 *
 * 它的**唯一消费者**就是本文件的 `pick()`（测试也改为经 `t()` / `uiText()` 间接断言）。
 * 独立成模块时，读文案要跨两个文件才能把「取用逻辑」与「数据」对上；且 `Record<MsgId, …>`
 * 已经用类型把两者绑死，无须再靠文件边界表达「它们是一对」。
 */
const MESSAGES: Record<MsgId, { en: string; zh: string }> = {
  // —— LV-1xxx 命令与交互 ——
  'LV-1001': {
    en: 'seek has no effect on a live stream (available for VOD/replay)',
    zh: 'seek 在直播流上不生效（点播/重播态可用）',
  },
  'LV-1002': {
    en: 'invalid playback rate, ignored: {rate}',
    zh: '倍速入参非法，已忽略：{rate}',
  },
  'LV-1003': {
    en: 'setAppState ignored non-app.* key: {key}',
    zh: 'setAppState 忽略非 app.* 键：{key}',
  },
  'LV-1004': {
    en: 'autoplay blocked, waiting for a user gesture',
    zh: '自动播放被拦截，等待用户手势',
  },
  'LV-1005': {
    en: 'Playback failed: {detail}',
    zh: '播放失败：{detail}',
  },

  // —— LV-2xxx 内核与媒体 ——
  'LV-2001': {
    en: 'media failed to load',
    zh: '媒体加载失败',
  },
  'LV-2002': {
    en: 'the platform supports no usable playback kernel',
    zh: '平台不支持任何可用播放内核',
  },
  'LV-2003': {
    en: 'HlsKernel created, url={url}',
    zh: 'HlsKernel 已创建，url={url}',
  },

  // —— LV-3xxx 网络与重连 ——
  'LV-3001': {
    en: 'native ended while live (playhead reached the end of the stream) -> treating as stream-interruption recovery',
    zh: '直播中收到原生 ended（播放点追至流末尾）→ 按断流恢复',
  },
  'LV-3002': {
    en: 'live stream stopped updating (playhead reached the end)',
    zh: '直播流停止更新（播放点追至末尾）',
  },
  'LV-3003': {
    en: 'buffer stalled, timed out',
    zh: '缓冲停滞超时',
  },
  'LV-3004': {
    en: 'Retry exhausted after {max} attempts ({code})',
    zh: '重试 {max} 次后仍失败（{code}）',
  },
  'LV-3005': {
    en: 'reconnecting',
    zh: '触发重连',
  },
  'LV-3006': {
    en: 'reconnect attempt #{count} ({code}) → {url}',
    zh: '重连第 {count} 次 ({code}) → {url}',
  },
  'LV-3007': {
    en: 'recover on returning to foreground',
    zh: '回前台恢复',
  },
  'LV-3008': {
    en: 'network offline, waiting to recover',
    zh: '网络断开，等待恢复',
  },
  'LV-3009': {
    en: 'Load timed out ({ms}ms)',
    zh: '加载超时（{ms}ms）',
  },

  // —— LV-4xxx 配置与接入 ——
  'LV-4001': {
    en: 'no playback URL provided (createPlayer.url or play(PlayConfig))',
    zh: '未提供播放地址（createPlayer.url 或 play(PlayConfig)）',
  },
  'LV-4002': {
    en: 'PlayConfig.url is missing',
    zh: 'PlayConfig.url 缺失',
  },
  'LV-4003': {
    en: 'Failed to resolve play config: {detail}',
    zh: '起播配置解析失败：{detail}',
  },
  'LV-4004': {
    en: 'container not found: {container}',
    zh: 'container 未找到：{container}',
  },
  'LV-4005': {
    en: 'container size is 0 ({width}×{height}); the player will show no picture. {hint}',
    zh: '容器尺寸为 0（{width}×{height}），播放器不会有可见画面。{hint}',
  },
  'LV-4006': {
    en: 'Give the container or its parent an explicit height, e.g. style="width:100%;height:300px".',
    zh: '请给容器或其父级确定的高度，例如 style="width:100%;height:300px"。',
  },
  'LV-4007': {
    en: 'kernel not initialized',
    zh: '内核未初始化',
  },

  // —— LV-5xxx 插件 ——
  'LV-5001': {
    en: 'reporter threw',
    zh: 'reporter 异常',
  },
  'LV-5002': {
    en: 'plugin is missing a name, cannot register',
    zh: '插件缺少 name，无法注册',
  },
  'LV-5003': {
    en: 'a plugin with the same name already exists, skipped: {name}',
    zh: '同名插件已存在，跳过：{name}',
  },
  'LV-5004': {
    en: 'ready() threw: {name}',
    zh: 'ready() 异常：{name}',
  },
  'LV-5005': {
    en: 'destroy() threw: {name}',
    zh: 'destroy() 异常：{name}',
  },
  'LV-5006': {
    en: 'response has no recognizable status field (status / liveStatus / state)',
    zh: '响应缺少可识别的状态字段（status / liveStatus / state）',
  },
  'LV-5007': {
    en: 'live status polling failed ({count} consecutive, {error}): {url}',
    zh: '直播状态轮询失败（连续 {count} 次，{error}）：{url}',
  },

  // —— LV-6xxx 能力对齐与档位 ——
  'LV-6001': {
    en: 'quality mapping failed, dropped: id={id}',
    zh: '档位映射失败，已剔除：id={id}',
  },
  'LV-6002': {
    en: 'unsupported by the client',
    zh: '客户端不支持',
  },
  'LV-6003': {
    en: 'not provided by the server',
    zh: '服务端未提供',
  },
  'LV-6004': {
    en: 'end-to-end mismatch',
    zh: '端到端未对齐',
  },
  'LV-6005': {
    en: 'native fallback path; casting is handled by the system',
    zh: '原生回退路径，投屏由系统接管',
  },

  // —— LV-7xxx UI 控件文案（**取用时不带编号前缀**，见 `utils/i18n.ts#uiText`）——
  // 面向终端用户：出现在 tooltip（`title`）、无障碍名（`aria-label`）与下拉项上，
  // 因此文案要**短**、**首字母大写**（英文），且不带 `[LV-xxxx]` 编号 —— 编号给开发看，不给用户看。
  'LV-7001': {
    en: 'Auto',
    zh: '自动',
  },
  'LV-7002': {
    en: 'Fullscreen',
    zh: '全屏',
  },
  'LV-7003': {
    en: 'Exit fullscreen',
    zh: '退出全屏',
  },
  'LV-7004': {
    en: 'Play',
    zh: '播放',
  },
  'LV-7005': {
    en: 'Pause',
    zh: '暂停',
  },
  'LV-7006': {
    en: 'Mute',
    zh: '静音',
  },
  'LV-7007': {
    en: 'Unmute',
    zh: '取消静音',
  },
  'LV-7008': {
    en: 'Volume',
    zh: '音量',
  },

  // —— LV-9xxx 兜底与内部不变量 ——
  'LV-9001': {
    en: 'event handler error: {event}',
    zh: '事件处理器异常：{event}',
  },
  'LV-9002': {
    en: 'locale change listener threw: {detail}',
    zh: '语言变更监听器异常：{detail}',
  },
}
