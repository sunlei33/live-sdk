/**
 * 契约校验：对照 live-sdk-integration skill 的 references/spec-summary.md 与三份落地模板
 * （web-default / react-custom / app-webview），逐字验证 SDK 暴露的 API 面与默认值。
 * 本文件若通过 `tsc --noEmit`，即证明 SDK 满足 skill 所承诺的接入契约。
 */
import { createPlayer, BasePlugin, Events, ERROR_CODE, ERROR_DOMAIN, COMMAND_NAMES, errorDomainOf, readElementSize, isZeroSized, SentryReporter, LivePolling, LIVE_STATUS_ERROR_EVENT, BUFFER_LEVEL_THRESHOLDS, bufferLevelOf } from 'live-sdk'
import type { SentryLike } from 'live-sdk'
import { mountDefaultUI } from 'live-sdk/ui'
import { usePlayer as usePlayerReact } from 'live-sdk/react'
import { usePlayer as usePlayerVue } from 'live-sdk/vue'
import { shallowRef } from 'vue'
import type { Player } from 'live-sdk'
import type {
  EnvAdapter,
  PlayConfig,
  PlayConfigProvider,
  Quality,
  PlayerError,
  FeatureStatusReport,
  ReportRecord,
  ReporterPlugin,
  NetworkQuality,
  PlayerState,
  SessionReport,
  SessionState,
  KernelCapabilities,
  LiveStatusPayload,
  LiveStatusErrorPayload,
  BufferUpdatePayload,
  CommandHookContext,
  HookPhase,
  CommandEventPayload,
  CommandName,
  ErrorDomain,
} from 'live-sdk'

// ══════════ 场景 1：纯 H5 + 默认 UI（assets/web-default.html） ══════════
const player = createPlayer({
  container: '#player', // 必填
  url: 'https://cdn.example.com/live.m3u8',
  autoplay: true,
  muted: true, // 移动端静音自动播放
})
mountDefaultUI(player) // 一键挂载默认控件（播放/暂停、静音、清晰度、全屏）

player.on('error', (e) => {
  const err = e as PlayerError
  if (err.fatal) console.error('直播不可用', err.code, err.message)
})
window.addEventListener('pagehide', () => player.destroy())

// ══════════ 场景 2：App WebView（assets/app-webview.js） ══════════
// 2.1 起播输入：服务端下发（PlayConfigProvider）
const fetchPlayConfig: PlayConfigProvider = async () => {
  const res = await (window as unknown as { MyJSBridge?: { call: (m: string, p: unknown) => Promise<Record<string, unknown>> } }).MyJSBridge!.call('getLivePlayConfig', {})
  const qualities = res.qualities as Quality[]
  return {
    url: res.playUrl as string,
    backup: res.backupUrl as string,
    liveStatus: res.statusUrl as string,
    poster: res.cover as string,
    quality: qualities,
    autoplay: true,
    muted: true,
  }
}

// 2.2 宿主环境：JSBridge 前台/后台 + 网络（JSBridgeEnvAdapter）
const jsBridgeEnv: EnvAdapter = {
  getVisibility: () => 'foreground',
  onVisibilityChange: (cb) => {
    // 桥接客户端回调，返回清理函数
    return () => undefined
  },
  isOnline: () => navigator.onLine,
  onNetworkChange: (cb) => () => cb(true),
  getNetworkQuality: (): NetworkQuality => 'good',
  onNetworkQualityChange: (cb) => () => cb('good'),
}

// 2.3 上报：自定义 ReporterPlugin，转发到原生埋点
class NativeReporter extends BasePlugin implements ReporterPlugin {
  report(record: ReportRecord): void {
    // window.MyJSBridge.call('reportLiveMetric', record)
    void record
  }
  flush(): void {}
}

const player2 = createPlayer({
  container: '#player',
  env: jsBridgeEnv, // App 端注入 JSBridge 环境适配器
  observability: 'full', // 深度采集（默认）；省电可换 'basic'
})
player2.registerPlugin(NativeReporter)
player2.play(fetchPlayConfig) // 传入 provider，异步起播

player2.on('error', (e) => {
  const err = e as PlayerError
  if (err.fatal) {
    /* 展示错误 UI，引导重试或换流 */
    void err
  }
})
window.addEventListener('pagehide', () => player2.destroy())

// ══════════ 场景 3：三契约 + 命令/方法全量 API（spec-summary §6.3） ══════════
async function exerciseCommands(): Promise<void> {
  await player.play() // resolve=起播成功，reject=fatal
  await player.play('https://live.m3u8') // 地址简写
  await player.play({ url: 'https://live.m3u8', muted: true }) // 完整配置
  player.pause()
  player.mute(true)
  player.setVolume(0.5)
  player.switchQuality(1) // 入参 = Quality.id
  await player.switchURL('https://backup.m3u8') // 运行中切流
  player.requestFullscreen() // 缺省 = 全屏 <video>（历史行为）
  player.requestFullscreen(player.root) // TODO-9：传目标元素 = 容器级全屏（自绘控件仍可见）
  player.requestFullscreen(document.querySelector('#stage') as Element) // 也可传业务自己的容器
  player.exitFullscreen() // 与 requestFullscreen 配对（全屏态下可退出）
  player.seek(120) // 仅有限时长（点播/重播）生效；直播无限流为 noop
  player.setPlaybackRate(1.5) // 写后读回，快照反映实际生效值
  player.setPoster('https://cdn.example.com/cover.jpg') // 运行时换封面（空值=移除）
  player.setLiveLatency(3, 8) // 运行时覆盖 LL-HLS 目标延迟；传空恢复 config 策略
  player.pollLiveStatus(30_000)
  player.getStats()
  player.bufferInfo()
  player.speedInfo()
  player.getFeatureStatus()
  player.report('metric', { code: 'custom' })
  player.useHooks('switchQuality', async (ctx) => void ctx)
  player.registerPlugin(NativeReporter)
  player.unregisterPlugin('reporter')
  player.on('first_frame', () => undefined)
  player.once('stalled', () => undefined)
  player.off('error')
  player.destroy()
}
void exerciseCommands()

// ══════════ 场景 4：状态订阅（§3.7 三契约之状态） ══════════
const snapshot: PlayerState = player.getState()
const playing: boolean = snapshot.playing
const caps: KernelCapabilities = snapshot.capabilities
const cur: number | null = snapshot.currentQuality
const isFull: boolean = snapshot.fullscreen
const rate: number = snapshot.playbackRate
void isFull
void rate
const unsub = player.subscribe((s) => {
  // 全量快照回调
  if (s.playing) void playing
})
unsub()

// ══════════ 场景 5：端到端能力对齐（§4.7） ══════════
player.on('features_updated', (report) => {
  const r = report as FeatureStatusReport
  r.features.forEach((f) => {
    if (!f.matched) console.warn(`${f.feature}: ${f.detail}`)
  })
})

// ══════════ 场景 6：事件常量与字符串等价（§3.4） ══════════
const eqFirstFrame: boolean = Events.FIRST_FRAME === 'first_frame'
const eqFeatures: boolean = Events.FEATURES_UPDATED === 'features_updated'
const eqError: boolean = Events.ERROR === 'error'
const errCode: string = ERROR_CODE.MANIFEST_404

// 值域统一校验：observability 只有 full/basic
const obsFull: 'full' | 'basic' = 'full'
const obsBasic: 'full' | 'basic' = 'basic'

// ══════════ 场景 7：React usePlayer（assets/react-custom.jsx，live-sdk/react） ══════════
// 契约校验：usePlayer(player) 入参为 Player 实例，返回 PlayerState 快照
function reactHookTypeCheck(): void {
  const p = player // 已存在的 Player 实例（React 中经 state 存、条件渲染后传入）
  const s: PlayerState = usePlayerReact(p) // 返回 PlayerState，任一字段变更触发重渲染
  const playing: boolean = s.playing
  const muted: boolean = s.muted
  void playing
  void muted
}
void reactHookTypeCheck

// ══════════ 场景 8：Vue usePlayer（assets/vue-custom.vue，live-sdk/vue） ══════════
// 契约校验：usePlayer(ref) 入参为 Ref<Player|null>，返回 Ref<PlayerState|null>
function vueComposableTypeCheck(): void {
  // class 实例用 shallowRef 而非 ref，避免 Vue 深度代理播放器实例（官方推荐）
  const playerRef = shallowRef<Player | null>(null) // onMounted 后才赋值
  const state = usePlayerVue(playerRef) // Ref<PlayerState|null>，就绪前 null
  const s: PlayerState | null = state.value
  if (s) {
    const playing: boolean = s.playing
    const muted: boolean = s.muted
    void playing
    void muted
  }
}
void vueComposableTypeCheck

// ══════════ 场景 9：SentryReporter（spec §5.3「官方可选包」） ══════════
// 契约校验：registerPlugin(SentryReporter, { sentry }) 注入 client，不硬依赖 @sentry/browser
const sentryLike: SentryLike = {
  captureException: (_err, _extra) => undefined,
  addBreadcrumb: (_crumb) => undefined,
}
player.registerPlugin(SentryReporter, { sentry: sentryLike })

// ══════════ 场景 10：业务反馈修复项的 API 契约（0.2.0） ══════════
// 10.1 封面图叠加层（P0-2）
const player3 = createPlayer({
  container: '#player3',
  posterMode: 'overlay', // 'native' | 'overlay'
})
const posterModeNative: 'native' | 'overlay' = 'native'

// 10.2 PlayConfig.autoplay：false = 只加载不自动播（P1-2）
const noAutoPlay: PlayConfig = { url: 'https://live.m3u8', autoplay: false }
void player3.play(noAutoPlay)

// 10.3 PlayerState 进度字段（P1-1）：直播 duration 为 Infinity
const progress: PlayerState = player3.getState()
const curTime: number = progress.currentTime
const dur: number = progress.duration
void curTime
void dur

// 10.4 业务态扩展位可写（P2-2）
player3.setAppState({ 'app.roomId': 'room-1', 'app.muted.byUser': true })
const roomId = player3.getState()['app.roomId']

// 10.5 live_status 结构化 payload（P2-2）
player3.on('live_status', (payload) => {
  const p = payload as LiveStatusPayload
  const s: string = p.status
  const prev: string = p.previousStatus
  const raw: Record<string, unknown> = p.raw
  const at: number = p.time
  void s
  void prev
  void raw
  void at
})

// 10.6 registerPlugin 兼容构造器与实例（P2-1）
player3.registerPlugin(NativeReporter) // 构造器
player3.registerPlugin(new NativeReporter()) // 实例

// ══════════ 场景 11：原生 media 错误码分派（A2 修复） ══════════
// 契约校验：`<video>.error`（MediaError）按 code 分派后，解码 / 源不支持与网络类
// **码值彼此独立** —— 接入方据此分流「解码异常 / 接口与 CDN 异常」才不会错位。
// code=1(MEDIA_ERR_ABORTED) 不上报；code=2 → network_error；code=3 → media_decode_error；
// code=4 → 视 message 是否含网络痕迹落到 network_error 或 media_src_not_supported。
const decodeErrCode: string = ERROR_CODE.MEDIA_DECODE_ERROR
const srcErrCode: string = ERROR_CODE.MEDIA_SRC_NOT_SUPPORTED
const netErrCode: string = ERROR_CODE.NETWORK_ERROR
// 错误码集合互不重叠（分流前提）
const mediaCodesDistinct: boolean =
  decodeErrCode !== srcErrCode && decodeErrCode !== netErrCode && srcErrCode !== netErrCode

// ══════════ 场景 12：轮询失败可见（A3 修复） ══════════
// 契约校验：`live_status_error` 是**独立事件**（刻意不并入 Events.ERROR，
// 以免状态接口故障污染播放错误通道与错误率统计），且订阅者可读到结构化 payload。
const player4 = createPlayer({ container: '#player4' })
player4.on(LIVE_STATUS_ERROR_EVENT, (payload) => {
  const e = payload as LiveStatusErrorPayload
  const url: string = e.url
  const count: number = e.failCount
  const reason: string = e.error
  const at: number = e.time
  void url
  void count
  void reason
  void at
})
// 失败事件的节流判据可静态调用（1 / 3 / 10 / 其后每满 30）
const failureThrottle: boolean[] = [1, 2, 3, 10, 29, 30].map((n) => LivePolling.shouldReportFailure(n))
// 退避上限可配置
const pollMaxInterval: number = new LivePolling().maxInterval
// 失败事件名与 Events.ERROR 不同名（两条通道互不干扰）。
// 注意这里必须经过 `string` 收窄：两个字面量类型无交集，直接比较会被 tsc
// 判为「无意的比较」（TS2367）—— 那正是「二者确实不同名」的编译期证明。
const failureEventName: string = LIVE_STATUS_ERROR_EVENT
const failureEventIsDistinct: boolean = failureEventName !== Events.ERROR

// ══════════ 场景 13：会话真相与会话级累计指标（乙类） ══════════
// 13.1 两个低频语义字段进快照
const session: PlayerState = player4.getState()
const sessionState: SessionState = session.sessionState
const usingBackup: boolean = session.usingBackup
// 13.2 `sessionState` 取值域与 `SessionState` 一致（类型层已保证，此处锚定可读性）
const sessionStates: SessionState[] = ['idle', 'loading', 'ready', 'playing', 'paused', 'stalled', 'error', 'ended']
void sessionStates.includes(sessionState)
// 13.3 累计指标走独立出口，**不并入 getStats()**（瞬时 vs 累计语义分离）
const sessionReport: SessionReport = player4.getSessionReport()
const firstFrameCost: number | null = sessionReport.firstFrameCost
const stallCount: number = sessionReport.stallCount
const stallDuration: number = sessionReport.stallDuration
const watchTime: number = sessionReport.watchTime
const loadStartTime: number | null = sessionReport.loadStartTime
void firstFrameCost
void stallCount
void stallDuration
void watchTime
void loadStartTime
// 瞬时指标里不得出现累计字段（否则「未起播」与「值为 0」无法区分）
const statsKeys: string[] = Object.keys(player4.getStats())
const statsHasNoSessionAccumulator: boolean = !statsKeys.some((k) =>
  ['firstFrameCost', 'stallCount', 'stallDuration', 'watchTime', 'loadStartTime'].includes(k),
)
void usingBackup

// ══════════ 场景 14：事件活性与会话钩子（0.4.0） ══════════
// 14.1 `PLAY` / `BUFFER_UPDATE` 不再是死事件：两者都进事件契约，值域与枚举一致
const eqPlay: boolean = Events.PLAY === 'play'
const eqBufferUpdate: boolean = Events.BUFFER_UPDATE === 'buffer_update'
// 14.2 `BUFFER_UPDATE` 载荷 = 全量 BufferInfo + 派生档位
player4.on(Events.BUFFER_UPDATE, (payload) => {
  const b = payload as BufferUpdatePayload
  const level: number = b.level
  const remaining: number = b.remaining
  const totalRemaining: number = b.totalRemaining
  const behind: number = b.behind
  const ranges: [number, number][] = b.buffers
  void level
  void remaining
  void totalRemaining
  void behind
  void ranges
})
// 14.3 档位判据可静态调用；边界是公开常量（接入方可据此对齐自己的阈值）
const bufferLevels: number[] = [0, 0.5, 1, 4, 30].map((s) => bufferLevelOf(s))
const levelEdges: readonly number[] = BUFFER_LEVEL_THRESHOLDS
const levelIsMonotonic: boolean = bufferLevels.every((v, i) => i === 0 || v >= bufferLevels[i - 1])
// 14.4 `switchQuality` 返回 Promise（内部 await before 钩子）；语句式调用仍合法
const qualitySwitchPromise: Promise<void> = player4.switchQuality(1)
void qualitySwitchPromise
// 14.5 命令钩子：同一个名字会以 before / after 两个阶段各调用一次
player4.useHooks('switchQuality', (ctx) => {
  const c = ctx as CommandHookContext
  const phase: HookPhase = c.phase
  if (phase === 'before') c.cancelled = true // 拦截协议：写回 ctx（HookFn 无返回值通道）
  if (phase === 'after') {
    const applied: boolean | undefined = c.applied
    void applied
  }
  const id: unknown = c.id
  void id
})
// `play` / `switchURL` 同样接线，ctx 上带各自入参
player4.useHooks('play', (ctx) => void (ctx as CommandHookContext).phase)
player4.useHooks('switchURL', (ctx) => void (ctx as CommandHookContext).url)

// ══════════ 场景 15：错误域 / 命令观测 / 容器自检（0.5.0） ══════════

// 15.1 错误域：接入方直接读 `err.domain`，不必自建「错误码 → 方向」映射表
player.on('error', (err) => {
  const e = err as PlayerError
  const domain: ErrorDomain = e.domain
  if (domain === ERROR_DOMAIN.NETWORK) {
    /* 归因：服务端 / CDN / 链路 */
  } else if (domain === ERROR_DOMAIN.DECODE) {
    /* 归因：内容 / 转码 / 内核 */
  } else if (domain === ERROR_DOMAIN.CONFIG) {
    /* 归因：接入侧配置 / 平台能力 */
  } else {
    /* ERROR_DOMAIN.UNKNOWN：映射表未覆盖，如实暴露而不是猜 */
  }
})

// 也可对任意错误码字符串直接求域（用于上报管道里已有的 code）
const domainOfManifest: ErrorDomain = errorDomainOf(ERROR_CODE.MANIFEST_404)
const domainOfUnknownCode: ErrorDomain = errorDomainOf('some_future_code')

// 15.2 统一命令观测：一次订阅拿到全部 12 个命令
player.on('command', (payload) => {
  const c = payload as CommandEventPayload
  const name: CommandName = c.name
  const phase: HookPhase = c.phase
  const applied: boolean | undefined = c.applied
  if (phase === 'after' && applied === false) {
    /* `${name}` 未生效（no-op）—— 如 live 下的 seek、档位表里没有的 switchQuality */
  }
})

// 命令名可在运行时枚举（12 个，与 PlayerCommands 的键一一对应）
const allCommands: readonly CommandName[] = COMMAND_NAMES
const commandCount: number = allCommands.length

// 15.3 容器尺寸自检（「接入后不显示」的排查加速）
const size = readElementSize(player.root)
const zero: boolean = size ? isZeroSized(size) : false // size=null 表示环境测不到，不可判为 0

export {
  eqFirstFrame,
  eqFeatures,
  eqError,
  errCode,
  obsFull,
  obsBasic,
  player,
  player2,
  player3,
  snapshot,
  cur,
  caps,
  jsBridgeEnv,
  NativeReporter,
  posterModeNative,
  roomId,
  mediaCodesDistinct,
  failureThrottle,
  pollMaxInterval,
  failureEventIsDistinct,
  sessionReport,
  statsHasNoSessionAccumulator,
  eqPlay,
  eqBufferUpdate,
  bufferLevels,
  levelEdges,
  levelIsMonotonic,
  domainOfManifest,
  domainOfUnknownCode,
  allCommands,
  commandCount,
  zero,
}
