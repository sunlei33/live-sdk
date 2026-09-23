import type { MsgId } from '../constants'

/**
 * 运行期消息文案表：编号 → `{ en, zh }`。
 *
 * **单一事实源**：所有面向人的消息（错误 / 日志 / 上报 / `FeatureStatus.detail` /
 * `zeroSizeHint` / 接入方可见的 `throw`）**以及 UI 控件文案**都从这里取，
 * 模块里**不再出现裸字符串**（含 `ui/` —— UI 文案同样走这张表，不再硬编码）。
 * 这样加一条消息只需两步：① 在 `constants.ts#MSG` 登记编号；② 在这里补中英文。
 *
 * **类型即完整性校验**：`Record<MsgId, …>` 是穷尽映射 —— 登记了编号却忘了补文案，
 * TypeScript 直接编译失败（比「运行时才发现某条消息是 undefined」早得多）。
 *
 * **两个取用入口**（都在 `utils/i18n.ts`，按受众区分）：
 * - `t(id, params)` → `[LV-xxxx] 文案`：面向**开发与排查**（错误 / 日志 / 上报）。
 * - `uiText(id, params)` → `文案`：面向**终端用户**（UI tooltip / `aria-label` / 下拉项），
 *   不带编号 —— 编号是给开发引用的，出现在 tooltip 里只是噪声。
 * 两者共用同一份文案表与同一个 locale，唯一差别是有无编号前缀。
 *
 * **占位符**：用 `{name}`，由 `utils/i18n.ts` 插值。
 * 未提供对应参数时占位符**原样保留**（`{name}`），便于一眼看出漏传。
 *
 * ⚠️ **编号与文案是两件事**：文案随 `PlayerConfig.locale` 与版本变化，编号恒定。
 * 接入方要锚定某条消息，请锚 `[LV-xxxx]` 编号，**不要**锚文案文本。
 */
export const MESSAGES: Record<MsgId, { en: string; zh: string }> = {
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
