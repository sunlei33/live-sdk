import { EventBus, type EventHandler } from './EventBus'
import { StateMachine } from './StateMachine'
import { MediaProxy } from './MediaProxy'
import { StateStore } from './StateStore'
import { Hooks } from './Hooks'
import { PluginManager } from './PluginManager'
import { HlsKernel } from '../kernel/HlsKernel'
import { NativeKernel } from '../kernel/NativeKernel'
import { ConsoleReporter } from '../reporter/ConsoleReporter'
import { LivePolling } from '../plugins/LivePolling'
import { WebEnvAdapter } from '../env/WebEnvAdapter'
import { Events, ERROR_CODE, DEFAULT_CONFIG, DEFAULT_NETWORK_STRATEGY, type SessionState } from '../constants'
import { deepMerge, resolveContainer } from '../utils/config'
import { canPlayNativeHLS, canPlayNativeMP4, supportsMSE } from '../utils/sniffer'
import { logger } from '../utils/logger'
import { shouldDedupError, computeRetryDelay, type DedupState } from '../utils/retry'
import { matchFeature } from '../utils/features'
import { mapErrorCode, isFatalKernelError, mapMediaErrorCode } from '../utils/errors'
import type {
  AppStateKey,
  BufferInfo,
  EnvAdapter,
  FeatureStatus,
  FeatureStatusReport,
  FeatureKey,
  Kernel,
  KernelCapabilities,
  KernelConstructor,
  LevelInfo,
  NetworkConfig,
  NetworkQuality,
  NetworkTunable,
  PlayerConfig,
  PlayConfig,
  PlayInput,
  PlayerError,
  PlayerState,
  Plugin,
  PluginInput,
  Quality,
  ReportRecord,
  RetryDiagnostic,
  SessionReport,
  SideState,
  SpeedInfo,
  StatsInfo,
} from '../types'

/** 功能插件预设（不含内核——内核由 kernel 配置 / sniffer 选路，见 §3.5） */
const PRESETS: Record<string, Array<{ new (): unknown; pluginName: string }>> = {
  live: [ConsoleReporter, LivePolling],
  vod: [ConsoleReporter],
}

export class Player {
  // —— 暴露给接入方的挂载点 ——
  readonly root: HTMLElement
  readonly media: HTMLVideoElement

  // —— 内部子系统 ——
  private eventBus = new EventBus()
  private stateMachine = new StateMachine()
  private hooks = new Hooks()
  private plugins: PluginManager
  private mediaProxy: MediaProxy
  private state: StateStore
  private env: EnvAdapter
  private config: PlayerConfig & { network: NetworkConfig; observability: 'full' | 'basic' }
  private kernel: Kernel | null = null

  // —— 运行期状态 ——
  private playRequestId = 0
  private retryCount = 0
  private currentPlayConfig: PlayConfig | null = null
  private qualityMap = new Map<number, number>() // business id → levelIndex
  private serverFeatures: Record<FeatureKey, SideState> = {
    lowLatency: 'unknown',
    abr: 'unknown',
    qualitySwitch: 'unknown',
    drm: 'unknown',
    // airplay 是纯客户端/平台能力，不依赖服务端 manifest → 服务端侧无条件满足（恒 supported），
    // 不能填 'unknown'——那会被误读成「尚未探测」，从而在 matched 里留下无意义的未对齐态。
    airplay: 'supported',
  }
  private timers = new Set<number>()
  private destroyed = false
  kernelReady = false
  private hasLoaded = false // 是否成功起播过（无参 play() 恢复语义的判据）
  private mediaPaused = false // 媒体真实暂停态兜底标志（状态机未覆盖的迁移路径）
  /**
   * 播放意图：用户/业务「想不想播」，与状态机瞬时会话态解耦。
   * 断流重连会经 error → retry → loading 把会话态推离 playing，但**意图仍是播放**
   * ——恢复成功后必须把 playing 快照还原，否则按钮会卡在「播放」图标（用户看到画面在放、按钮却是播放）。
   * 仅显式 pause()/ended 才置 false。
   */
  private playIntent = false
  private lastRetryDiagnostic: RetryDiagnostic | null = null // 最近一次重试诊断快照
  private firstFrameEmitted = false
  private loadTimeoutTimer: number | null = null
  private disposedSubs: Array<() => void> = []
  private posterEl: HTMLImageElement | null = null // overlay 模式的封面图层（懒建）
  private progressSecond = -1 // 已同步到快照的整秒位置（节流用）
  /**
   * LL-HLS 延迟的**运行时覆盖**（`setLiveLatency` 命令写入），null = 未覆盖、
   * 回落到 `config.network` 的动态策略。与 config 分离是为了让「业务临时调低延迟」
   * 不污染 `PlayerConfig`，且能被一键清除恢复。
   */
  private latencyOverride: { target?: number; max?: number } | null = null

  // ─────────── 会话级累计指标（getSessionReport，见 types.ts#SessionReport） ───────────
  // 全部以「已结算累计量 + 进行中时段起点」两段式记录：读的时候把进行中的一段
  // 实时补上，不需要定时器轮询，也不会在暂停/卡顿时把时长算漏。
  /** 本轮会话起播时刻（play() 新一轮起播时重置） */
  private sessionLoadStartTime: number | null = null
  /** 本轮会话首帧耗时（ms）；出首帧后不再改写，新一轮起播重置为 null */
  private sessionFirstFrameCost: number | null = null
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

  constructor(config: PlayerConfig) {
    // 1. 解析容器
    const container = resolveContainer(config.container)

    // 2. 配置三层合并
    const merged = deepMerge<PlayerConfig>(DEFAULT_CONFIG as PlayerConfig, config)
    merged.network = deepMerge<NetworkConfig>(DEFAULT_NETWORK_STRATEGY, config.network)
    this.config = merged as Player['config']

    // 3. 建根容器 + video
    this.root = document.createElement('div')
    this.root.style.position = 'relative'
    this.root.style.width = '100%'
    this.root.style.height = '100%'
    this.mediaProxy = new MediaProxy()
    this.media = this.mediaProxy.el
    this.media.style.position = 'absolute'
    this.media.style.inset = '0'
    this.media.style.width = '100%'
    this.media.style.height = '100%'
    this.root.appendChild(this.media)
    container.appendChild(this.root)

    // 4. env 适配器
    this.env = config.env ?? new WebEnvAdapter()

    // 5. 状态快照初始值
    const initial: PlayerState = {
      playing: false,
      volume: this.mediaProxy.volume,
      muted: this.mediaProxy.muted,
      qualities: [],
      currentQuality: null,
      // 会话真相由状态机在 onStateChange 里持续写入；此处与 StateMachine 的初值对齐
      sessionState: 'idle',
      usingBackup: false,
      currentTime: 0,
      duration: 0,
      fullscreen: false,
      playbackRate: this.mediaProxy.playbackRate,
      capabilities: this.emptyCapabilities(),
    }
    this.state = new StateStore(initial)

    // 6. 插件管理
    this.plugins = new PluginManager(this)

    // 7. 装载预设插件
    this.applyPreset()

    // 8. 绑定 env / 状态机 / media 事件
    this.bindEnv()
    this.stateMachine.onChange((next) => this.onStateChange(next))
    this.bindMediaEvents()

    // 9. 缺省地址 + 自动起播
    if (this.config.url && this.config.autoplay) {
      void this.play({
        url: this.config.url,
        autoplay: true,
        muted: this.config.muted,
      })
    }
  }

  // ═══════════════ 命令契约（PlayerCommands） ═══════════════

  async play(input?: PlayInput): Promise<void> {
    if (this.destroyed) return
    const reqId = ++this.playRequestId

    // 无参 play()：若已成功起播过（hasLoaded），语义是「恢复播放」而非「重新起播」——
    // 对应状态机 paused →(play)→ playing，不重新拉流（直播恢复不该重建 buffer）。
    if (input === undefined && this.hasLoaded) {
      // 乐观更新：`playing` 事件是异步派发的，若等到 await 之后再改快照，
      // 调用方（含 PlayButton 的同步读取）会拿到过期的 playing=false。
      // 这里先同步纠正快照，失败时再回滚。
      this.playIntent = true
      this.mediaPaused = false
      this.state.set({ playing: true })
      try {
        await this.mediaProxy.play()
      } catch (err) {
        // 被中断（AbortError）视为正常竞态；被拦截（NotAllowedError）回滚后静默。
        if (this.handlePlayRejection(err)) return
        // 起播失败（如自动播放被拦截）：回滚快照与意图，交由接入方处理
        this.playIntent = false
        this.mediaPaused = true
        this.state.set({ playing: false })
        const e = this.makeError(ERROR_CODE.PLAY_FAILED, (err as Error).message, false)
        this.dispatchError(e)
        throw err
      }
      return
    }

    let cfg: PlayConfig
    try {
      cfg = await this.resolveConfig(input)
    } catch (err) {
      const e = this.makeError(ERROR_CODE.CONFIG_RESOLVE_FAILED, `起播配置解析失败：${(err as Error).message}`, true)
      this.dispatchError(e)
      throw err
    }
    if (reqId !== this.playRequestId) return // 过期请求忽略

    this.currentPlayConfig = cfg
    const muted = cfg.muted ?? this.config.muted ?? false
    this.mediaProxy.muted = muted
    this.applyPoster(cfg.poster)
    // 新一轮起播：进度归零，等待 loadedmetadata/timeupdate 回填
    this.progressSecond = -1
    // 新一轮起播 = 新一轮会话：累计指标清零、备用流标记复位。
    // **必须在 transition('load') 之前** —— onStateChange 会在状态迁移时结算
    // 「进行中的 playing / stalled 时段」，若先迁移再重置，旧会话的尾巴会被算进新会话。
    this.resetSession()
    this.state.set({ muted, currentTime: 0, duration: 0, usingBackup: false })
    this.startLivePollingIfNeeded()

    this.retryCount = 0
    this.mediaPaused = false // 新一轮起播，重置暂停兜底标志
    // 播放意图 = 本次起播是否「自动开始播放」。
    // `PlayConfig.autoplay: false` 的语义是「只加载、不自动播」（典型场景：先呈现封面图，
    // 等用户手势再播），因此意图为负 —— 不自动 play()、按钮保持「播放」态；
    // 之后业务显式调用 `play()`（无参）走恢复分支，再把意图转正。
    // 缺省（undefined）视为 true：调用 play() 本身就是播放意图，保持既有行为不变。
    this.playIntent = cfg.autoplay !== false
    this.emit(Events.LOAD_START, { url: cfg.url })
    this.stateMachine.transition('load')

    try {
      const kernel = this.ensureKernel(cfg.url)
      await kernel.load(cfg.url)
      this.hasLoaded = true
      this.startLoadTimeout()
      this.applyLiveLatency()
    } catch (err) {
      this.dispatchError(this.makeError(ERROR_CODE.MANIFEST_LOAD_ERROR, (err as Error).message, false))
      throw err
    }
  }

  pause(): void {
    this.mediaProxy.pause()
    // 显式暂停 = 用户意图转为「不播」，重连逻辑不应再把它还原为播放中
    this.playIntent = false
    // 乐观更新：浏览器 `pause` 事件是异步派发的，若只等事件，`getState().playing`
    // 在调用后仍为 true，UI 按钮/接入方同步读取会拿到过期状态。
    // 这里先行纠正快照，随后到达的 media `pause` 事件做幂等确认。
    this.mediaPaused = true
    if (this.state.get().playing) this.state.set({ playing: false })
  }

  mute(m: boolean): void {
    this.mediaProxy.muted = m
    this.state.set({ muted: m })
  }

  setVolume(v: number): void {
    this.mediaProxy.volume = v
    this.state.set({ volume: v })
  }

  switchQuality(id: number): void {
    if (!this.kernel?.capabilities.qualitySwitch) return
    if (id === -1) {
      // 恢复自动（ABR）
      this.kernel.switchQuality(-1)
      this.state.set({ currentQuality: null })
      this.emit(Events.ABR_CHANGE, { level: 'auto' })
      return
    }
    const idx = this.qualityMap.get(id)
    if (idx === undefined) return
    this.kernel.switchQuality(idx)
    this.state.set({ currentQuality: id })
    this.emit(Events.QUALITY_CHANGE, { id })
  }

  async switchURL(url: string): Promise<void> {
    if (this.destroyed || !this.kernel) throw new Error('内核未初始化')
    try {
      await this.kernel.switchURL(url)
      if (this.currentPlayConfig) this.currentPlayConfig.url = url
      // 业务**主动**换源：不该再标记为「备用流中」（那是断流自动降级才有的状态）。
      // 但会话统计不重置 —— 换源属于同一次观看行为，切开会让观看时长/卡顿次数断裂。
      this.state.set({ usingBackup: false })
    } catch (err) {
      this.dispatchError(this.makeError(ERROR_CODE.MANIFEST_LOAD_ERROR, (err as Error).message, false))
      throw err
    }
  }

  requestFullscreen(): void {
    this.mediaProxy.requestFullscreen()
  }

  exitFullscreen(): void {
    this.mediaProxy.exitFullscreen()
  }

  /**
   * 定位到指定时间（秒），入参钳制到 `[0, duration]`。
   *
   * **直播无限流（`duration === Infinity`）下为 noop** —— 直播时间轴受 live edge 约束，
   * 任意定位只会持续累积延迟（README「Non-Goals」）；点播 / 重播回放为正常用法。
   */
  seek(time: number): void {
    if (this.destroyed) return
    const duration = this.media.duration
    if (!Number.isFinite(duration)) {
      logger.debug('[live-sdk] seek 在直播无限流上不生效（点播/重播态可用）')
      return
    }
    const upper = duration > 0 ? duration : time
    const target = Math.min(Math.max(time, 0), upper)
    this.mediaProxy.seek(target)
    // 乐观更新：`timeupdate` 是异步的（~4Hz），业务在 seek() 后同步读
    // getState().currentTime 会拿到旧值；此处先纠正快照与节流游标。
    this.progressSecond = Math.floor(target)
    this.state.set({ currentTime: target })
  }

  /**
   * 设置倍速。**直播主场景不建议**（变速持续累积/消耗延迟、破坏边缘跟随）；
   * 点播 / 重播回放为正常用法。写后读回，快照反映浏览器实际生效值（可能被钳制）。
   */
  setPlaybackRate(rate: number): void {
    if (this.destroyed) return
    try {
      this.mediaProxy.playbackRate = rate
    } catch {
      logger.warn(`[live-sdk] 倍速入参非法，已忽略：${rate}`)
      return
    }
    this.state.set({ playbackRate: this.mediaProxy.playbackRate })
  }

  /** 运行时更换封面（`undefined` / 空串 = 移除）；呈现方式仍由 `PlayerConfig.posterMode` 决定。 */
  setPoster(poster?: string): void {
    this.applyPoster(poster)
  }

  /**
   * 运行时覆盖 LL-HLS 目标延迟（秒）。传空 = 清除本次覆盖、恢复 `config.network`
   * 的动态策略；内核无 `setLiveLatency` 能力时静默忽略。
   */
  setLiveLatency(target?: number, max?: number): void {
    this.latencyOverride = target === undefined && max === undefined ? null : { target, max }
    this.applyLiveLatency()
  }

  // ═══════════════ 状态契约 ═══════════════

  getState(): PlayerState {
    return this.state.get()
  }

  /**
   * 写入**业务扩展状态**（`PlayerState` 的 `app.*` 命名空间，§3.7）。
   *
   * 内核只保证 `app.` 前缀字段不被自己读写，命名与结构完全由业务/插件决定；
   * 写入后照常触发 `subscribe` 全量快照回调，因此能自然驱动 React/Vue 重渲染。
   *
   * ```ts
   * player.setAppState({ 'app.muted.byUser': true, 'app.roomId': '123' })
   * player.getState()['app.roomId'] // '123'
   * ```
   *
   * @throws 不会抛错：非 `app.` 前缀的键会被**忽略并告警**（运行时兜底，
   *         防止无类型约束的 JS 调用方覆盖 `playing`/`muted` 等内核字段）。
   */
  setAppState(patch: Record<AppStateKey, unknown>): void {
    const safe: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(patch)) {
      if (!k.startsWith('app.')) {
        // 前缀由 logger 统一补（[live-sdk]），此处只给模块标签
        logger.warn(`[state] setAppState 忽略非 app.* 键：${k}`)
        continue
      }
      safe[k] = v
    }
    if (Object.keys(safe).length === 0) return
    this.state.set(safe as Partial<PlayerState>)
  }

  subscribe(cb: (s: PlayerState) => void): () => void {
    return this.state.subscribe(cb)
  }

  // ═══════════════ 事件契约 ═══════════════

  on(event: string, handler: EventHandler): () => void {
    return this.eventBus.on(event, handler)
  }

  off(event: string, handler?: EventHandler): void {
    this.eventBus.off(event, handler)
  }

  once(event: string, handler: EventHandler): () => void {
    return this.eventBus.once(event, handler)
  }

  emit(event: string, data?: unknown): void {
    this.eventBus.emit(event, data)
  }

  // ═══════════════ 可观测 ═══════════════

  getStats(): StatsInfo {
    return this.kernel?.getStats() ?? {}
  }

  bufferInfo(): BufferInfo {
    return this.kernel?.bufferInfo() ?? { buffers: [], behind: 0, remaining: 0, length: 0, totalRemaining: 0, totalLength: 0 }
  }

  speedInfo(): SpeedInfo {
    const s = this.getStats()
    return { speed: s.speed ?? 0, avgSpeed: s.avgSpeed ?? 0 }
  }

  /**
   * 读取**会话级累计指标**：首帧耗时 / 卡顿次数与时长 / 实际播放时长 / 起播时刻。
   *
   * 与 `getStats()` 的分工（勿混）：
   * - `getStats()` 是「此刻这一瞬间」的质量快照（码率 / fps / 丢帧），字段全 optional；
   * - 本方法返回「本轮会话自起播以来」的累计量，字段一律有确切含义（详见 `SessionReport`）。
   *
   * 进行中的时段（正在播放 / 正在卡顿）会按「此刻 − 起点」实时计入，因此返回值
   * 是调用当刻的准确值，无需等时段结束。这些量原本要靠每个接入方各写一份
   * 「记时间戳 → 配对收口 → 维护计数器」的样板代码，且极易在配对边界上算错。
   */
  getSessionReport(): SessionReport {
    const now = Date.now()
    return {
      firstFrameCost: this.sessionFirstFrameCost,
      stallCount: this.stallCount,
      stallDuration: this.stallAccum + (this.stallSince !== null ? now - this.stallSince : 0),
      watchTime: this.watchAccum + (this.watchSince !== null ? now - this.watchSince : 0),
      loadStartTime: this.sessionLoadStartTime,
    }
  }

  /**
   * 重置会话级累计指标。**只由 `play()` 的新一轮起播调用**（见 `SessionReport` 会话边界）。
   *
   * 这里直接清零而不是先结算：会话既然要重新开始，旧会话那段进行中的时长本就应该
   * 被丢弃；若先结算再清零等于白算一次，反而容易让人误以为「旧数据被带进新会话」。
   * 读接口 `getSessionReport()` 自己会补上进行中的一段，所以清零不会造成漏计。
   */
  private resetSession(): void {
    this.watchAccum = 0
    this.watchSince = null
    this.stallAccum = 0
    this.stallSince = null
    this.stallCount = 0
    this.sessionLoadStartTime = Date.now()
    this.sessionFirstFrameCost = null
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

  report(type: ReportRecord['type'], data: Record<string, unknown>): void {
    this.dispatchReport({
      type,
      code: (data.code as string) ?? 'custom',
      level: (data.level as ReportRecord['level']) ?? 'info',
      data,
      time: Date.now(),
    })
  }

  // ═══════════════ 端到端能力对齐 ═══════════════

  getFeatureStatus(): FeatureStatusReport {
    const caps = this.kernel?.capabilities ?? this.emptyCapabilities()
    const full = this.config.observability === 'full'
    const client: Record<FeatureKey, SideState> = {
      lowLatency: caps.lowLatency && full ? 'supported' : 'absent',
      abr: caps.abr ? 'supported' : 'absent',
      qualitySwitch: caps.qualitySwitch ? 'supported' : 'absent',
      drm: 'absent', // §1.3 划出，恒 absent
      // 投屏/画中画：原生回退路径由浏览器接管（degraded = SDK 不提供但平台可用），
      // MSE 路径需 SDK 保证 <video> 可被系统投屏捕获，故记 supported。
      // 注意：MSE 接管 src 后系统投屏按钮会消失，属需主动规避的回归。
      airplay: caps.nativeFallback ? 'degraded' : 'supported',
    }
    const features: FeatureStatus[] = (Object.keys(client) as FeatureKey[]).map((feature) =>
      matchFeature(feature, client[feature], this.serverFeatures[feature]),
    )
    const matched = features.filter((f) => f.matched).length
    return { features, summary: { matched, mismatched: features.length - matched } }
  }

  // ═══════════════ 插件 / 钩子 ═══════════════

  /**
   * 注册插件：**构造器或实例皆可**（§3.6）。
   * - `registerPlugin(SentryReporter, { sentry })` —— 传构造器
   * - `registerPlugin(new SentryReporter(), { sentry })` —— 传实例
   *
   * 两种形态都会走 `create(player)` → `init(config)`，业务不要自行预先 register。
   */
  registerPlugin(plugin: PluginInput, config?: unknown): Plugin {
    return this.plugins.add(plugin, config)
  }

  unregisterPlugin(name: string): void {
    this.plugins.remove(name)
  }

  useHooks(name: string, fn: (ctx: Record<string, unknown>) => void | Promise<void>): () => void {
    return this.hooks.use(name, fn)
  }

  /** 注册销毁钩子（供 mountDefaultUI 等在 destroy 时卸载控件） */
  onDestroy(fn: () => void): void {
    this.disposedSubs.push(fn)
  }

  async runHooks(name: string, ctx: Record<string, unknown>): Promise<void> {
    await this.hooks.run(name, ctx)
  }

  /**
   * 当前内核实例（未初始化时为 null）。
   *
   * 用途：接入方在深度定制时可能需要读写内核扩展能力（如 `getLevels()` 做自绘清晰度面板）；
   * 同时 E2E 测试通过它注入「场务指令」以驱动内核异常分支（见 test/e2e/harness.html）。
   * 注意：返回的是内部实例，调用方不应绕过 Player 直接改状态。
   */
  getKernel(): unknown {
    return this.kernel
  }

  // ═══════════════ 直播状态轮询 ═══════════════

  pollLiveStatus(interval?: number): void {
    const polling = this.plugins.get<LivePolling>('livePolling')
    const url = this.currentPlayConfig?.liveStatus
    if (!polling || !url) return
    polling.start(url, interval)
  }

  // ═══════════════ 销毁 ═══════════════

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    // 全屏中销毁：先退出全屏再拆 DOM，否则部分浏览器会把页面卡在全屏态
    // （移除全屏元素虽通常触发自动退出，但不保证同步完成）。
    if (this.mediaProxy.isFullscreen()) this.mediaProxy.exitFullscreen()
    // 清理定时器
    for (const t of this.timers) window.clearTimeout(t)
    this.timers.clear()
    this.clearLoadTimeout()
    // 解绑监听
    for (const unsub of this.disposedSubs) unsub()
    this.disposedSubs = []
    // 内核优先销毁：必须在移除 <video> 之前完成，让 hls.js 能正常
    // detachMedia → revoke object URL → 关闭 MediaSource（否则 <video> 已移除，
    // hls.js 的清理回调可能操作悬空节点，且 object URL 泄漏）。
    this.kernel?.destroy()
    this.kernel = null
    this.plugins.destroyAll()
    this.mediaProxy.destroy()
    this.destroyPosterEl()
    this.root.remove()
    this.state.destroy()
    this.hooks.destroy()
    this.eventBus.removeAll()
  }

  // ═══════════════ 内部：配置解析 ═══════════════

  private async resolveConfig(input?: PlayInput): Promise<PlayConfig> {
    let raw: PlayInput
    if (input === undefined) {
      if (!this.config.url) throw new Error('未提供播放地址（createPlayer.url 或 play(PlayConfig)）')
      raw = this.config.url
    } else {
      raw = input
    }
    let cfg: PlayConfig
    if (typeof raw === 'string') cfg = { url: raw }
    else if (typeof raw === 'function') cfg = await raw()
    else cfg = raw
    if (!cfg || !cfg.url) throw new Error('PlayConfig.url 缺失')
    return cfg
  }

  // ═══════════════ 内部：内核选路与创建 ═══════════════

  private ensureKernel(url: string): Kernel {
    if (this.kernel) return this.kernel
    const Ctor = this.selectKernel(url)
    const kernel = new Ctor({
      media: this.media,
      hlsConfig: this.config.hlsConfig,
      observability: this.config.observability,
      onEvent: (event, data) => this.handleKernelEvent(event, data),
    })
    this.kernel = kernel
    this.state.set({ capabilities: kernel.capabilities })
    return kernel
  }

  /** 内核选路 = f(源格式, 平台能力, 观测档位)，见 §7.2 */
  private selectKernel(_url: string): KernelConstructor {
    if (this.config.kernel) return this.config.kernel
    const obs = this.config.observability
    if (obs === 'full') {
      if (HlsKernel.isSupported()) return HlsKernel
      return NativeKernel // 无 MSE（Safari <17.1）→ 原生 HLS，深度观测落 basic
    }
    // basic
    if (canPlayNativeHLS(this.media)) return NativeKernel
    if (canPlayNativeMP4(this.media)) return NativeKernel // 渐进式 MP4 直连
    if (supportsMSE() && HlsKernel.isSupported()) return HlsKernel
    throw new Error('平台不支持任何可用播放内核')
  }

  private emptyCapabilities(): KernelCapabilities {
    return { lowLatency: false, qualitySwitch: false, abr: false, stats: 'basic', nativeFallback: false }
  }

  // ═══════════════ 内部：内核事件 → 状态机 / 事件 / 能力 ═══════════════

  private handleKernelEvent(event: string, data?: unknown): void {
    this.emit(Events.KERNEL_EVENT, { type: event, data })
    switch (event) {
      case 'manifest_parsed':
        this.onManifestParsed(data)
        break
      case 'levels_updated':
        this.updateQualities()
        break
      case 'level_switched':
        this.emit(Events.ABR_CHANGE, data)
        break
      case 'error':
        this.onKernelError(data)
        break
      case 'frag_loaded':
        this.emit(Events.SPEED_UPDATE, this.speedInfo())
        break
      default:
        break
    }
  }

  private onManifestParsed(data?: unknown): void {
    this.clearLoadTimeout()
    this.probeServerFeatures(data)
    this.updateQualities()
    this.stateMachine.transition('manifestParsed')
    this.emit(Events.MANIFEST_PARSED, data)
    this.emit(Events.FEATURES_UPDATED, this.getFeatureStatus())
    this.attemptPlay()
  }

  private onKernelError(data?: unknown): void {
    const d = (data ?? {}) as {
      fatal?: boolean
      details?: string
      type?: string
      message?: string
      response?: { code?: number }
    }
    const details = d.details ?? ''
    const fatal = isFatalKernelError(details, d.type, d.fatal === true)
    // HTTP 状态码：hls.js 放在 data.response.code，不在 details 里。
    // 不取它则 404 无法从 details 识别（details 恒为 manifestLoadError）。
    const code = mapErrorCode(details, d.response?.code)
    this.dispatchError(this.makeError(code, d.message ?? details, fatal))
  }

  // ═══════════════ 内部：media 原生事件 ═══════════════

  private bindMediaEvents(): void {
    const el = this.media
    const on = (name: string, fn: EventListener) => {
      el.addEventListener(name, fn)
      this.disposedSubs.push(() => el.removeEventListener(name, fn))
    }

    on('loadedmetadata', () => {
      // 原生回退路径的「就绪」信号
      if (this.stateMachine.current === 'loading') this.onManifestParsed({})
      this.syncProgress()
    })
    on('loadeddata', () => this.onFirstFrameSignal())
    on('canplay', () => this.onFirstFrameSignal())
    on('timeupdate', () => this.syncProgress())
    on('durationchange', () => this.syncProgress())
    on('playing', () => this.onMediaPlaying())
    on('pause', () => this.onMediaPause())
    on('waiting', () => this.onStall())
    on('stalled', () => this.onStall())
    on('ended', () => {
      this.playIntent = false // 播完 = 意图终止，重连逻辑不得复活
      this.mediaPaused = true
      this.stateMachine.transition('ended')
      this.emit(Events.ENDED)
    })
    on('volumechange', () => this.state.set({ volume: this.media.volume, muted: this.media.muted }))
    // 倍速也可能被外部（直接操作 media）改动：跟随同步并去重，避免重复渲染
    on('ratechange', () => {
      const rate = this.media.playbackRate
      if (rate !== this.state.get().playbackRate) this.state.set({ playbackRate: rate })
    })
    on('error', () => {
      // 原生 media error（NativeKernel / 渐进式直连路径）。
      // `<video>.error` 是 MediaError，其 `code` 是规范里的**定值枚举**、语义可靠 →
      // 按 code 分派（详见 utils/errors.ts#mapMediaErrorCode）。
      // 早期实现一律映射成 network_error，会把解码 / 格式类错误打进「接口与 CDN」，
      // 使接入方按错误码做的分类上报整体错位。
      const mediaError = this.media.error
      const mapped = mapMediaErrorCode(mediaError?.code, mediaError?.message)
      if (!mapped) return // code=1：换源 / 销毁引发的中止，不是故障
      this.dispatchError(this.makeError(mapped.code, mediaError?.message || '媒体加载失败', mapped.fatal))
    })

    // —— 全屏状态同步 ——
    // 标准 Fullscreen API 在 document 上派发；iOS 原生视频全屏走 video 私有事件，
    // 且**不派发 fullscreenchange**。两条路径都要监听，否则 iOS 上全屏态永远不同步。
    const onDoc = (name: string, fn: EventListener) => {
      document.addEventListener(name, fn)
      this.disposedSubs.push(() => document.removeEventListener(name, fn))
    }
    onDoc('fullscreenchange', () => this.syncFullscreen())
    onDoc('webkitfullscreenchange', () => this.syncFullscreen())
    on('webkitbeginfullscreen', () => this.syncFullscreen())
    on('webkitendfullscreen', () => this.syncFullscreen())
  }

  /** 把全屏真实状态同步到快照（去重后写，避免重复事件驱动无意义的重渲染）。 */
  private syncFullscreen(): void {
    const full = this.mediaProxy.isFullscreen()
    if (full !== this.state.get().fullscreen) this.state.set({ fullscreen: full })
  }

  private onMediaPlaying(): void {
    this.playIntent = true // 媒体真的在播 → 意图同步为正
    // 每次起播（含二次 play/换源）都会派发 playing：封面图层真正的收口点
    this.hidePosterOverlay()
    if (this.stateMachine.current === 'stalled') {
      this.stateMachine.transition('recovered')
      this.emit(Events.RECOVERED)
    } else {
      this.stateMachine.transition('play')
    }
    this.emit(Events.PLAYING)
  }

  /**
   * media `pause` 事件 → 状态机。
   * 注意：`playing` 态下 `stall` 会先把状态机推到 `stalled`（此时 `playing` 快照仍为 true），
   * 若用户此刻 pause，必须能迁到 `paused` —— 该边已在状态表中显式声明
   * （见 StateMachine 的注释：缺这条边会让 `sessionState` 停在「卡顿中」，
   * 且「进行中的卡顿时长」永远得不到结算）。
   * 下面的兜底分支仅用于**其余**未覆盖的源状态（如 `loading`）：以「实际媒体已暂停」为准，
   * 只要快照仍标记为播放中，就强制纠正，避免 UI 与内核状态分叉。
   */
  private onMediaPause(): void {
    // 初始化期噪声抑制：首帧前，浏览器/内核常派发伪 `pause` 事件
    // （如 MSE attach 前后的 AbortError 伴随的 pause、同源重新 loadSource 的中间态）。
    // 此时会话尚在 loading/ready，用户并未按下暂停，不得把意图置负，
    // 否则「起播后的自动续播」会被误判为用户暂停（表现为按钮反复切换）。
    if (!this.firstFrameEmitted && this.stateMachine.current !== 'playing') {
      return
    }
    this.playIntent = false // 媒体真的停了（用户暂停 / 播完）→ 意图同步为负
    if (this.stateMachine.transition('pause')) {
      this.emit(Events.PAUSE)
      return
    }
    // 迁移表未覆盖（如 stalled / loading）→ 以媒体真实状态兜底，避免 UI 与内核状态分叉
    this.mediaPaused = true
    if (this.state.get().playing) {
      this.state.set({ playing: false })
      this.emit(Events.PAUSE)
    }
  }

  private onStall(): void {
    if (this.stateMachine.current !== 'playing') return
    // 近尾特殊处理：部分内核（尤其 Android WebView 解码器）在接近
    // 末尾时会停止推进，但 buffer 其实已经够播完。此时卡在 `stalled` 会走到「重连」，
    // 语义上是错的——内容已经放完，只是没派发 `ended`。判据：最后缓冲区间末端 ≈ 媒体总
    // 时长（且非直播无限流），则直接判 `ended`，不再启动重连定时器。
    if (this.isNearTail()) {
      this.playIntent = false
      this.mediaPaused = true
      if (this.stateMachine.transition('ended')) this.emit(Events.ENDED)
      return
    }
    this.stateMachine.transition('stall')
    this.emit(Events.STALLED)
    // 启动恢复定时器：超时 → 重连
    const timeout = this.resolveTunable(this.config.network.loadTimeout)
    const timer = window.setTimeout(() => {
      if (this.stateMachine.current === 'stalled') {
        // 超时前再判一次近尾：解码器可能在等待期间才补完最后一帧
        if (this.isNearTail()) {
          this.playIntent = false
          this.mediaPaused = true
          if (this.stateMachine.transition('ended')) this.emit(Events.ENDED)
          return
        }
        this.stateMachine.transition('timeout')
        this.recover(ERROR_CODE.LOAD_TIMEOUT, '缓冲停滞超时')
      }
    }, timeout)
    this.addTimer(timer)
  }

  /**
   * 是否处于「近尾」：当前播放点之后已缓冲到媒体末尾，且距末尾在容差内。
   * 直播无限流（duration=Infinity/NaN）恒为 false，避免把正常缓冲误判为播完。
   * 容差取 max(0.5s, 最后区间长度的小比例)，兼顾正常结尾与异常流的时长偏差。
   */
  private isNearTail(tolerance = 0.5): boolean {
    const el = this.media
    const duration = el.duration
    if (!Number.isFinite(duration) || duration <= 0) return false // 直播无限流
    const buffered = el.buffered
    if (!buffered || buffered.length === 0) return false
    const bufferEnd = buffered.end(buffered.length - 1)
    // buffer 已到末尾（允许极小误差）+ 播放点也贴近末尾
    const bufferAtEnd = duration - bufferEnd <= tolerance
    const playAtEnd = duration - el.currentTime <= Math.max(tolerance, 1)
    return bufferAtEnd && playAtEnd
  }

  private emitFirstFrame(): void {
    if (this.firstFrameEmitted) return
    this.firstFrameEmitted = true
    this.hidePosterOverlay()
    this.emit(Events.FIRST_FRAME, { time: Date.now() })
    this.plugins.readyAll()
    this.kernelReady = true
  }

  /**
   * 首帧信号入口（`loadeddata` / `canplay` 都会到，谁先到算谁）。拆成两步是因为
   * 它们服务两个**生命周期不同**的语义：
   * - `markSessionFirstFrame()`：本轮会话的首帧耗时 —— **每次起播都要重新计**；
   * - `emitFirstFrame()`：`FIRST_FRAME` 事件 + `plugins.readyAll()` —— 历史行为是
   *   **一次性闸门、二次起播不重置**（它兼作「插件可以开始工作了」的就绪信号，
   *   重复派发没有意义，且 `applyPoster` 的隐藏逻辑依赖这个特性）。
   *
   * 早期实现只调 `emitFirstFrame()`，于是「切档 / 换源后重新起播」这条路径上闸门已关，
   * 永远不会记录首帧耗时（`firstFrameCost` 停在 null）。两者必须分开。
   */
  private onFirstFrameSignal(): void {
    this.markSessionFirstFrame()
    this.emitFirstFrame()
  }

  /**
   * 记录本轮会话首帧耗时（幂等：一轮会话只记第一次）。
   * 不依赖 `firstFrameEmitted` —— 见 `onFirstFrameSignal` 的注释。
   */
  private markSessionFirstFrame(): void {
    if (this.sessionFirstFrameCost !== null) return
    if (this.sessionLoadStartTime === null) return // 未经 play()（如直接操作 media），无起播基准
    this.sessionFirstFrameCost = Date.now() - this.sessionLoadStartTime
  }

  // ═══════════════ 内部：封面图层（posterMode） ═══════════════

  /**
   * 应用封面图。两种模式（§4.1 PlayerConfig.posterMode）：
   * - `native`：写 `<video>.poster`，交给浏览器原生呈现（历史行为）。
   * - `overlay`：在 root 内叠一层 `<img>`，首帧呈现后隐藏。
   *   MSE 路径推荐——hls.js 接管 `<video>.src` 为 `blob:` 后原生 poster 不可靠。
   */
  private applyPoster(poster?: string): void {
    if (this.config.posterMode !== 'overlay') {
      this.mediaProxy.poster = poster
      return
    }
    // overlay 模式不写 video.poster，避免与图层重复呈现
    if (!poster) {
      this.hidePosterOverlay()
      return
    }
    const el = this.ensurePosterEl()
    el.src = poster
    el.style.display = 'block'
    // 注意：不要重置 firstFrameEmitted —— 它还兼作 plugins.readyAll()/kernelReady 的一次性闸门。
    // 二次起播时 emitFirstFrame 不再触发，改由 onMediaPlaying（playing 事件，每次起播都会派发）兜底隐藏。
  }

  private ensurePosterEl(): HTMLImageElement {
    if (this.posterEl) return this.posterEl
    const el = document.createElement('img')
    el.className = 'live-sdk-poster'
    Object.assign(el.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      display: 'none',
      // 低于默认控件层（UIMount 的 controls bar 为 z-index:10），不遮挡操作
      zIndex: '1',
    })
    el.setAttribute('alt', '')
    this.root.appendChild(el)
    this.posterEl = el
    return el
  }

  /** 隐藏封面图层（幂等）。首帧呈现、进入播放时调用。 */
  private hidePosterOverlay(): void {
    if (this.posterEl) this.posterEl.style.display = 'none'
  }

  private destroyPosterEl(): void {
    this.posterEl?.remove()
    this.posterEl = null
  }

  // ═══════════════ 内部：播放进度同步 ═══════════════

  /**
   * 把播放位置/时长同步到快照（`PlayerState.currentTime` / `duration`）。
   *
   * **节流**：仅在「整秒位置变化」或「duration 变化」时才写快照 ——
   * `timeupdate` 约 4Hz，直接写会让订阅方（React/Vue 组件）被高频重渲染；
   * 快照定位是低频字段（StateStore 注释），逐帧精度请读 `player.media.currentTime`。
   */
  private syncProgress(): void {
    const t = this.media.currentTime || 0
    const second = Math.floor(t)
    const raw = this.media.duration
    // 直播：duration 恒为 Infinity（HTMLMediaElement 规范），如实透传；
    // 元数据未就绪：NaN；老浏览器/极简 DOM 替身可能为 undefined → 统一归一为 0，
    // 避免业务侧渲染出 NaN/undefined。
    const duration = typeof raw === 'number' && !Number.isNaN(raw) ? raw : 0
    if (second === this.progressSecond && duration === this.state.get().duration) return
    this.progressSecond = second
    this.state.set({ currentTime: t, duration })
  }

  // ═══════════════ 内部：自动播放 / 状态机副作用 ═══════════════

  /**
   * 统一的 play() Promise 失败处理：把「被中断」与「被拦截」从真实错误中区分出来。
   * - AbortError：被新的 play()/pause()/loadSource 打断，属正常竞态，**静默忽略**
   *   （初始化期与重连期高频出现，若当错误上报会造成误报噪声——
   *   `AbortError: The user aborted a request` 即此类）。
   * - NotAllowedError：自动播放被浏览器拦截，回滚意图与快照，等待用户手势。
   * 返回 true 表示已处理（调用方无需再抛错）。
   */
  private handlePlayRejection(err: unknown): boolean {
    if (this.destroyed) return true
    const name = (err as DOMException)?.name
    if (name === 'AbortError') return true
    if (name === 'NotAllowedError') {
      this.playIntent = false
      this.mediaPaused = true
      this.state.set({ playing: false })
      logger.warn('[live-sdk] 自动播放被拦截，等待用户手势')
      return true
    }
    return false
  }

  private attemptPlay(): void {
    // 仅在「意图播放」时才自动续播：用户已显式暂停（playIntent=false）时，
    // manifest 重新解析（如切档、重连）不得把用户按下的暂停偷偷改成播放。
    if (!this.playIntent) return
    // 快照与意图对齐：`playing` 事件可能不会在「同源重新 load」后再次触发
    // （<video> 从未进入 paused，只是 buffer 被替换），单等事件会导致按钮卡在「播放」。
    this.mediaPaused = false
    this.state.set({ playing: true })
    const p = this.mediaProxy.play()
    if (!p || typeof p.catch !== 'function') return
    p.catch((err) => {
      if (this.handlePlayRejection(err)) return
      this.dispatchError(this.makeError(ERROR_CODE.UNKNOWN, `播放失败：${(err as Error).message}`, false))
    })
  }

  private onStateChange(next: SessionState): void {
    if (next === 'paused' || next === 'playing') this.mediaPaused = next === 'paused'

    // —— 会话级累计指标：进入 / 离开 playing、stalled 各在此收口 ——
    // 关键设计：**离开路径统一在这里结算，而不是只在 RECOVERED 里累加**。
    // 卡顿并不总以 `RECOVERED` 结束 —— 期间可能迁到 `error`（重连）、`ended`（近尾判完）、
    // 或被用户 `pause`；漏了任何一条，那段卡顿时长就永久少计（且很难被发现）。
    // 在此集中结算后，新增任何状态迁移路径都自动被覆盖。
    const now = Date.now()
    this.settleWatch(now)
    this.settleStall(now)
    if (next === 'playing') this.watchSince = now
    if (next === 'stalled') {
      this.stallCount++
      this.stallSince = now
    }

    // `playing` 快照 = 「呈现给用户的播放/暂停语义」，不是会话态的机械映射：
    //   - `playing`  → true
    //   - `stalled`  → true（已起播只是缓冲，UI 仍是播放中）；但用户已显式暂停时除外
    //   - `paused` / `ended` → false（用户态暂停/结束）
    //   - `loading` / `error` / `ready` / `idle` → 保持 playIntent：
    //     断流重连（error→retry→loading）只是内部恢复过程，媒体的真实暂停态未变、
    //     用户的播放意图也未变，按钮**不应**在重连期间闪现「播放」图标。
    //     若此刻媒体确已暂停（用户显式 pause，mediaPaused=true），则应显示「播放」。
    let playing: boolean
    if (next === 'playing') playing = true
    else if (next === 'stalled') playing = !this.mediaPaused
    else if (next === 'paused' || next === 'ended') playing = false
    else playing = this.playIntent && !this.mediaPaused
    // 与 `playing` 并列写入 `sessionState`：前者是呈现语义、后者是会话真相，
    // 卡顿时二者刻意分叉（详见 PlayerState.sessionState 注释）。
    this.state.set({ playing, sessionState: next })
  }

  // ═══════════════ 内部：错误分级与恢复 ═══════════════

  private makeError(code: string, message: string, fatal: boolean, diagnostic?: RetryDiagnostic): PlayerError {
    if (diagnostic) this.lastRetryDiagnostic = diagnostic
    return { code, message, fatal, retryCount: this.retryCount, diagnostic: diagnostic ?? this.lastRetryDiagnostic ?? undefined }
  }

  private dispatchError(err: PlayerError): void {
    // 同类错误节流去重（10s 窗口）
    if (this.lastErrorDedup(err)) return
    // 可恢复错误会自动重连：为接入方补齐「当前地址 + 网络环境」诊断，便于线上排查。
    // fatal 错误不重连，但同样带上快照（可能是重试耗尽后的终态）。
    const diagnostic = err.diagnostic ?? this.buildDiagnostic(err.code, 0)
    const out: PlayerError = { ...err, diagnostic }
    this.lastRetryDiagnostic = diagnostic
    this.emit(Events.ERROR, out)
    this.dispatchReport({
      type: 'error',
      code: out.code,
      level: out.fatal ? 'fatal' : 'warn',
      data: { message: out.message, retryCount: out.retryCount, diagnostic },
      time: Date.now(),
    })
    if (out.fatal) {
      this.clearLoadTimeout()
      this.stateMachine.transition('error')
      return
    }
    this.recover(out.code, out.message)
  }

  private lastErrState: DedupState = { code: '', time: 0 }

  private lastErrorDedup(err: PlayerError): boolean {
    return shouldDedupError(this.lastErrState, err, Date.now())
  }

  private recover(code: string, message: string): void {
    if (this.stateMachine.current === 'stalled') this.stateMachine.transition('timeout')
    else this.stateMachine.transition('error')

    const max = this.resolveTunable(this.config.network.retryCount)
    if (this.retryCount >= max) {
      this.dispatchError(
        this.makeError(ERROR_CODE.RETRY_EXHAUSTED, `重试 ${max} 次后仍失败：${message}`, true, this.buildDiagnostic(code, 0)),
      )
      return
    }
    this.retryCount++
    const base = this.resolveTunable(this.config.network.retryDelay)
    const delay = computeRetryDelay(base, this.retryCount)
    const diagnostic = this.buildDiagnostic(code, delay)
    logger.warn('[live-sdk] 触发重连', diagnostic)
    this.emit(Events.RETRY, { code, retryCount: this.retryCount, delay, diagnostic })
    this.dispatchReport({ type: 'event', code: 'retry', level: 'warn', data: { message, ...diagnostic }, time: Date.now() })
    this.stateMachine.transition('retry')
    const timer = window.setTimeout(() => this.reload(code, diagnostic), delay)
    this.addTimer(timer)
  }

  private reload(code: string, diagnostic?: RetryDiagnostic): void {
    if (this.destroyed || !this.currentPlayConfig) return
    const cfg = this.currentPlayConfig
    const useBackup = !!cfg.backup && this.retryCount === 1
    const url = useBackup ? (cfg.backup as string) : cfg.url
    const diag = this.buildDiagnostic(code, diagnostic?.delay ?? 0, url)
    logger.warn(`[live-sdk] 重连第 ${this.retryCount} 次 (${code}) → ${url}`, diag)
    // 若用户的意图仍是播放，重连期间保持按钮为「播放中」，避免 UI 在退避等待中闪现暂停图标
    this.mediaPaused = false
    // 同步「当前是否在播备用流」：第 1 次重连换 backup，其后各次回主地址。
    // 必须与 playing 在同一次 set 里跟上 —— 否则 UI 会一直显示「备用流中」，
    // 而实际早已回到主源（接入方据此判断降级状态，错标会误导排查方向）。
    this.state.set({ playing: this.playIntent, usingBackup: useBackup })
    this.emit(Events.LOAD_START, { url, retry: true, diagnostic: diag })
    try {
      const pending = this.kernel?.load(url) as Promise<void> | undefined
      this.startLoadTimeout()
      // `kernel.load()` 是**异步**的：外层 try/catch 只能拦住同步抛错，拦不住它的 reject。
      // 不消费这个 Promise 会产生 unhandledrejection —— Node/SSR 下直接崩进程，
      // 浏览器里落到 `window.onunhandledrejection`（接入方的全局错误监控会收到一条
      // 与播放无关的噪声，且这次重连失败本身也不会进入 SDK 的错误通道）。
      // 所以必须显式消费，并把它引回 SDK 的错误分级链路（继续重试直至耗尽）。
      if (pending && typeof pending.catch === 'function') {
        pending.catch((err) => {
          if (this.destroyed) return
          this.dispatchError(this.makeError(ERROR_CODE.MANIFEST_LOAD_ERROR, (err as Error).message, false, diag))
        })
      }
    } catch (err) {
      this.dispatchError(this.makeError(ERROR_CODE.MANIFEST_LOAD_ERROR, (err as Error).message, false, diag))
    }
  }

  /**
   * 采集「当前播放地址 + 当前网络环境」诊断快照（重试时上报）。
   * 地址取本次实际要请求的 url；网络环境优先走 EnvAdapter 的扩展能力，
   * 并叠加 Network Information API（effectiveType/downlink/rtt）与缓冲/进度上下文。
   */
  private buildDiagnostic(errorCode: string, delay: number, urlOverride?: string): RetryDiagnostic {
    const cfg = this.currentPlayConfig
    const primaryUrl = cfg?.url ?? ''
    const url = urlOverride ?? (cfg?.backup && this.retryCount === 1 ? cfg.backup : primaryUrl)
    const buffered = this.bufferInfo()
    const nav = typeof navigator !== 'undefined' ? navigator : undefined
    const conn = (nav as Navigator & {
      connection?: { effectiveType?: string; downlink?: number; rtt?: number }
    } | undefined)?.connection
    return {
      url,
      primaryUrl,
      isBackup: !!cfg?.backup && url === cfg.backup,
      networkQuality: this.currentQuality(),
      online: this.env.isOnline(),
      visibility: this.env.getVisibility(),
      effectiveType: conn?.effectiveType,
      downlink: conn?.downlink,
      rtt: conn?.rtt,
      bufferBehind: Number(buffered.behind.toFixed(2)),
      bufferRemaining: Number(buffered.remaining.toFixed(2)),
      currentTime: Number((this.media.currentTime || 0).toFixed(2)),
      retryCount: this.retryCount,
      delay,
      errorCode,
      time: Date.now(),
    }
  }

  /** 读取最近一次重试诊断（无重试时为 null）——便于接入方/测试直接查询 */
  getLastRetryDiagnostic(): RetryDiagnostic | null {
    return this.lastRetryDiagnostic
  }

  // ═══════════════ 内部：网络自适应 ═══════════════

  private currentQuality(): NetworkQuality {
    if (this.env.getNetworkQuality) return this.env.getNetworkQuality()
    return this.env.isOnline() ? 'good' : 'offline'
  }

  private resolveTunable(t: NetworkTunable): number {
    return typeof t === 'function' ? t(this.currentQuality()) : t
  }

  /**
   * 应用目标延迟：**运行时覆盖优先，未覆盖项回落到 config 的动态策略**
   * （按当前网络质量求值）。网络质量变化时由 bindEnv 重新调用本方法，
   * 因此仅在覆盖了某一项时，另一项仍能随网络自适应。
   */
  private applyLiveLatency(): void {
    if (!this.kernel?.setLiveLatency) return
    const o = this.latencyOverride
    const target = o?.target ?? this.resolveTunable(this.config.network.targetLatency)
    const max = o?.max ?? this.resolveTunable(this.config.network.maxLatency)
    this.kernel.setLiveLatency(target, max)
  }

  // ═══════════════ 内部：env 适配 ═══════════════

  private bindEnv(): void {
    this.disposedSubs.push(
      this.env.onVisibilityChange((v) => {
        this.emit(Events.VISIBILITY_CHANGE, { visibility: v })
        if (v === 'background') this.onBackground()
        else this.onForeground()
      }),
    )
    this.disposedSubs.push(
      this.env.onNetworkChange((online) => {
        if (!online) this.onOffline()
        this.emit(Events.KERNEL_EVENT, { type: 'network', online })
      }),
    )
    if (this.env.onNetworkQualityChange) {
      this.disposedSubs.push(
        this.env.onNetworkQualityChange(() => {
          this.applyLiveLatency()
        }),
      )
    }
  }

  private onBackground(): void {
    // 直播切后台：暂停心跳/轮询（省电）；可选静音。此处在 base 版仅暂停轮询。
    this.plugins.get<LivePolling>('livePolling')?.stop()
  }

  private onForeground(): void {
    // 回前台：检查并续播（结合断流重连）
    if (this.stateMachine.current === 'error' || this.stateMachine.current === 'stalled') {
      this.recover(ERROR_CODE.NETWORK_ERROR, '回前台恢复')
    } else if (this.currentPlayConfig?.liveStatus) {
      this.plugins.get<LivePolling>('livePolling')?.start(this.currentPlayConfig.liveStatus)
    }
  }

  private onOffline(): void {
    logger.warn('[live-sdk] 网络断开，等待恢复')
  }

  // ═══════════════ 内部：清晰度映射（§4.3） ═══════════════

  private updateQualities(): void {
    const business = this.currentPlayConfig?.quality ?? []
    const levels = this.kernel?.getLevels?.() ?? []
    if (levels.length === 0) {
      this.state.set({ qualities: [], currentQuality: null })
      return
    }
    const map = new Map<number, number>()
    const valid: Quality[] = []
    for (const q of business) {
      const idx = this.matchQuality(q, levels)
      if (idx >= 0) {
        map.set(q.id, idx)
        valid.push(q)
      } else {
        logger.warn(`[live-sdk] 档位映射失败，已剔除：id=${q.id}`)
      }
    }
    this.qualityMap = map
    this.state.set({ qualities: valid })
  }

  private matchQuality(q: Quality, levels: LevelInfo[]): number {
    if (q.height != null) {
      const hit = levels.find((l) => l.height === q.height)
      if (hit) return hit.index
    }
    if (q.bitrate != null) {
      let best = -1
      let bestDiff = Infinity
      for (const l of levels) {
        const d = Math.abs(l.bitrate - q.bitrate)
        if (d < bestDiff) {
          bestDiff = d
          best = l.index
        }
      }
      return best
    }
    return -1
  }

  // ═══════════════ 内部：服务端能力探测（§4.7） ═══════════════

  private probeServerFeatures(data?: unknown): void {
    const d = (data ?? {}) as { levels?: unknown[]; hasLL?: boolean; levelsInfo?: unknown }
    const levels = this.kernel?.getLevels?.() ?? []
    const multi = levels.length > 1
    const hasLL = (d as { hasLL?: boolean }).hasLL === true
    this.serverFeatures = {
      lowLatency: hasLL ? 'supported' : 'absent',
      abr: multi ? 'supported' : 'absent',
      qualitySwitch: multi ? 'supported' : 'absent',
      drm: 'absent',
      // airplay 是纯客户端/平台能力，与 manifest 无关 → 服务端侧无条件满足（恒 supported）。
      // 不用 'unknown'：那表示「尚未探测」，会污染 matched 口径（本轮修复的 bug 根因）。
      airplay: 'supported',
    }
  }

  // ═══════════════ 内部：直播轮询 ═══════════════

  private startLivePollingIfNeeded(): void {
    const url = this.currentPlayConfig?.liveStatus
    if (!url) return
    this.plugins.get<LivePolling>('livePolling')?.start(url)
  }

  // ═══════════════ 内部：预设 / 上报 / 定时器 ═══════════════

  private applyPreset(): void {
    const preset = this.config.preset
    const ignores = this.config.ignores ?? []
    let list: Array<{ new (): unknown; pluginName: string }> = []
    if (Array.isArray(preset)) {
      list = preset as unknown as Array<{ new (): unknown; pluginName: string }>
    } else if (typeof preset === 'string' && PRESETS[preset]) {
      list = PRESETS[preset]
    }
    for (const Ctor of list) {
      if (ignores.includes(Ctor.pluginName)) continue
      this.plugins.add(Ctor as never)
    }
  }

  private dispatchReport(record: ReportRecord): void {
    for (const p of this.plugins.all()) {
      const rp = p as unknown as { report?: (r: ReportRecord) => void }
      try {
        rp.report?.(record)
      } catch (err) {
        logger.error('[live-sdk] reporter 异常', err)
      }
    }
  }

  private startLoadTimeout(): void {
    this.clearLoadTimeout()
    const timeout = this.resolveTunable(this.config.network.loadTimeout)
    const timer = window.setTimeout(() => {
      if (this.stateMachine.current === 'loading') {
        this.dispatchError(this.makeError(ERROR_CODE.LOAD_TIMEOUT, `加载超时（${timeout}ms）`, false))
      }
    }, timeout)
    this.loadTimeoutTimer = timer
    this.addTimer(timer)
  }

  private clearLoadTimeout(): void {
    if (this.loadTimeoutTimer !== null) {
      window.clearTimeout(this.loadTimeoutTimer)
      this.timers.delete(this.loadTimeoutTimer)
      this.loadTimeoutTimer = null
    }
  }

  private addTimer(t: number): void {
    this.timers.add(t)
  }
}
