import { EventBus, type EventHandler } from './EventBus'
import { StateMachine } from './StateMachine'
import { StateStore } from './StateStore'
import { Hooks } from './Hooks'
import { PluginManager } from './PluginManager'
import { QualityController } from './QualityController'
import { SessionMetrics } from './SessionMetrics'
import {
  Events,
  ERROR_CODE,
  MSG,
  DEFAULT_LOCALE,
  DEFAULT_CONFIG,
  DEFAULT_NETWORK_STRATEGY,
  bufferLevelOf,
  type CommandName,
  type SessionState,
} from '../constants'
import { deepMerge } from '../utils/config'
import { logger } from '../utils/logger'
import { mapErrorCode, isFatalKernelError, mapMediaErrorCode, errorDomainOf } from '../utils/errors'
import { isZeroSized } from '../utils/size'
import { setLocale, t } from '../utils/i18n'
import type {
  AppStateKey,
  BufferInfo,
  BufferUpdatePayload,
  CommandHookContext,
  EnvAdapter,
  FeatureStatus,
  FeatureStatusReport,
  FeatureKey,
  HookPhase,
  HostMount,
  Kernel,
  KernelCapabilities,
  KernelConstructor,
  MediaEventName,
  MediaSurface,
  NetworkConfig,
  NetworkQuality,
  NetworkTunable,
  PlatformAdapters,
  PlayerConfig,
  PluginPresetEntry,
  PlayConfig,
  PlayInput,
  PlayerError,
  PlayerState,
  Plugin,
  PluginInput,
  ReportRecord,
  RetryDiagnostic,
  SessionReport,
  SideState,
  SpeedInfo,
  StatsInfo,
} from '../types'

/**
 * core 对「直播状态轮询插件」的全部了解：**只认行为形状，不认实现**。
 *
 * 这样 `LivePolling` 可以留在 `plugins/`（实现层），而 core 不必 `import` 它 ——
 * 是 P0 解耦的一部分（见 `verify/layers.mjs`：core 不得依赖实现层）。
 * 插件按名字装配（`preset.live` 由平台包给出），交互只经这一小段协议。
 */
interface LivePollingLike {
  start(url?: unknown, interval?: number): void
  stop(): void
}

/**
 * 同类错误去重状态（每个 `Player` 实例各持一份，多实例天然隔离）。
 *
 * 原 `utils/retry.ts#DedupState` —— 该模块的唯一消费者就是本类，故随逻辑一并并入，
 * 并降级为**文件内局部**（不再是模块导出）。
 */
interface DedupState {
  code: string
  time: number
}

/**
 * 同类错误去重窗口（ms）：同类错误在该窗口内只暴露一次。
 *
 * 原 `utils/retry.ts#ERROR_DEDUP_WINDOW_MS`，同上并入。
 */
const ERROR_DEDUP_WINDOW_MS = 10_000

export class Player {
  // —— 暴露给接入方的挂载点 ——
  //
  // ⚠️ **类型策略（有意为之，见 spec §3.10）**：这两个字段对外仍声明 Web 类型，
  // 但**值来自注入的平台包**（`HostMount.root` / `MediaSurface.raw`，契约里是 `unknown`）。
  // 于是 core 运行时不引用任何 DOM 全局，而公开类型对 Web 接入方零变化。
  // 将来接非 Web 宿主时，这里需要放宽为泛型（已记为后续项）。
  readonly root: HTMLElement
  readonly media: HTMLVideoElement

  // —— 内部子系统 ——
  private eventBus = new EventBus()
  private stateMachine = new StateMachine()
  private hooks = new Hooks()
  private plugins: PluginManager
  /** 媒体设备面（由平台注入；core 不知道它是 `<video>` 还是别的宿主媒体） */
  private surface: MediaSurface<unknown>
  /** 宿主承载面（由平台注入；core 不知道它是不是 DOM） */
  private host: HostMount<unknown>
  /** 平台装配包（内核选路 / 默认插件预设也在这里） */
  private platform: PlatformAdapters<unknown, unknown>
  private state: StateStore
  private env: EnvAdapter
  private config: PlayerConfig & { network: NetworkConfig; observability: 'full' | 'basic' }
  private kernel: Kernel | null = null

  // —— 运行期状态 ——
  private playRequestId = 0
  private retryCount = 0
  private currentPlayConfig: PlayConfig | null = null
  // 清晰度映射表 + 服务端能力声明：两者都是「随内核/清单重建」的派生数据，
  // 已抽为独立单元（`core/QualityController.ts`），它只持有数据与纯计算、不产生副作用。
  private quality = new QualityController()
  private timers = new Set<number>()
  private destroyed = false
  /**
   * 内核是否已就绪（首帧闸门）。**保持 `private`** —— 判据只服务本文件。
   *
   * `PluginManager` 需要它时，由 `addPlugin` 判断后传下去（而不是让它自己去读）：
   * TS 的 `private` 按类封装、兄弟类也算外部，跨类读取会迫使字段放宽成公开成员 ——
   * 它曾因此进到 `dist` 的 `.d.ts`，接入方可写。现由 `verify/visibility.mjs` 兜底。
   */
  private kernelReady = false
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
  private progressSecond = -1 // 已同步到快照的整秒位置（节流用）
  private sizeWarned = false // 容器零尺寸告警只报一次，避免刷屏
  /**
   * 上次已派发的缓冲水位档位（`-1` = 本轮尚未派发过）。
   * `BUFFER_UPDATE` 的节流状态：只在档位**跨越边界**时派发，见 `checkBufferLevel()`。
   */
  private bufferLevel = -1
  /**
   * LL-HLS 延迟的**运行时覆盖**（`setLiveLatency` 命令写入），null = 未覆盖、
   * 回落到 `config.network` 的动态策略。与 config 分离是为了让「业务临时调低延迟」
   * 不污染 `PlayerConfig`，且能被一键清除恢复。
   */
  private latencyOverride: { target?: number; max?: number } | null = null

  // ─────────── 会话级累计指标（getSessionReport，见 types.ts#SessionReport） ───────────
  // 7 个字段与整套「清零 / 起记 / 结算 / 读」逻辑已抽为独立单元（`core/SessionMetrics.ts`）：
  // 它自带完整生命周期，且只有 6 个方法碰它 —— 字段—方法引用矩阵里内聚度最高的一块。
  private session = new SessionMetrics()

  /**
   * @param config 接入方配置
   * @param platform **平台装配包**：媒体面 / 承载面 / 宿主环境 / 内核选路 / 默认插件预设。
   *   缺省由 `createPlayer` 注入 Web 实现（`src/platform/web/`）。
   *
   *   为什么是**第二个参数**而不是让 core 自己 import：见 spec §3.10 与 `verify/layers.mjs`
   *   —— core 不得在运行时依赖任何实现层，否则「换媒体面 / 换内核 / 换宿主」都要改 core。
   */
  constructor(config: PlayerConfig, platform: PlatformAdapters<unknown, unknown>) {
    this.platform = platform

    // 1. 配置三层合并
    const merged = deepMerge<PlayerConfig>(DEFAULT_CONFIG as PlayerConfig, config)
    merged.network = deepMerge<NetworkConfig>(DEFAULT_NETWORK_STRATEGY, config.network)
    this.config = merged as Player['config']
    // 运行期消息语言：**全局**设置（与 setLogLevel 同类语义），必须早于任何可能产出消息的动作
    setLocale(this.config.locale ?? DEFAULT_LOCALE)

    // 2. 挂载：容器解析、根节点创建、media 挂进 DOM 全部由承载面负责（core 不碰 DOM）
    this.surface = platform.media
    this.host = platform.host
    this.media = platform.media.raw as HTMLVideoElement
    this.root = platform.host.root as HTMLElement
    try {
      platform.host.mount(config.container, platform.media.raw)
    } catch (err) {
      // 容器解析失败（如选择器不存在）：回收已创建的媒体面，保持与迁移前一致的「构造失败即无副作用」
      platform.media.destroy()
      throw err
    }

    // 3. env 适配器（接入方显式指定优先，其次平台默认）
    this.env = config.env ?? platform.env

    // 4. 状态快照初始值
    const initial: PlayerState = {
      playing: false,
      volume: this.surface.volume,
      muted: this.surface.muted,
      qualities: [],
      currentQuality: null,
      // 会话真相由状态机在 onStateChange 里持续写入；此处与 StateMachine 的初值对齐
      sessionState: 'idle',
      usingBackup: false,
      currentTime: 0,
      duration: 0,
      fullscreen: false,
      playbackRate: this.surface.playbackRate,
      capabilities: this.emptyCapabilities(),
    }
    this.state = new StateStore(initial)

    // 5. 插件管理
    this.plugins = new PluginManager(this)

    // 6. 装载预设插件
    this.applyPreset()

    // 7. 绑定 env / 状态机 / media 事件
    this.bindEnv()
    this.stateMachine.onChange((next) => this.onStateChange(next))
    this.bindMediaEvents()

    // 8. 缺省地址 + 自动起播
    if (this.config.url && this.config.autoplay) {
      void this.play({
        url: this.config.url,
        autoplay: true,
        muted: this.config.muted,
      })
    }
  }

  // ═══════════════ 命令契约（PlayerCommands） ═══════════════

  /**
   * 起播。结构分三相（此前是一个整体）：
   *
   * | 相 | 职责 | 位置 |
   * |---|---|---|
   * | ① 门卫 | 销毁检查 / 零尺寸自检 / `reqId` 竞态 / before 钩子 | 本方法内 |
   * | ② 恢复播放 | 无参 `play()` 且已起播过 → **只唤醒媒体、不重新拉流** | `resumePlayback` |
   * | ③ 起播新流 | 解析配置 → 重置会话与意图 → 建内核并加载 | `startPlayback` |
   *
   * ②③ 各自负责自己的「钩子收尾 + `COMMAND` 事件」——**刻意不合并**，因为它们本就不对称：
   * ② 被中断（AbortError）时不调 `hookAfter`；③ 解析失败要抛 `fatal` 错误。
   * ① 的三条早返回路径只报 `applied=false`，与后两相无关。
   */
  async play(input?: PlayInput): Promise<void> {
    this.emitCommand('play', 'before')
    if (this.destroyed) {
      this.emitCommand('play', 'after', false)
      return
    }
    // 起播这一刻仍无尺寸 → 大概率是接入问题（见 warnIfZeroSize）
    this.warnIfZeroSize()
    const reqId = ++this.playRequestId

    // 前置钩子：可异步拦截本次起播（如「未登录不允许起播」「先补一次鉴权」）。
    // 放在 reqId 自增之后：钩子 await 期间若有新的 play() 进来，reqId 失配会被下面的
    // 检查挡掉，不会出现两次起播各自加载的竞态。
    const hookCtx = this.hookCtx({ input })
    if (await this.hookBefore('play', hookCtx)) {
      this.emitCommand('play', 'after', false) // 被钩子拦截
      return
    }
    if (reqId !== this.playRequestId) {
      this.emitCommand('play', 'after', false) // 被更新的 play() 取代，本次未产生作用
      return
    }

    // 无参 play()：若已成功起播过（hasLoaded），语义是「恢复播放」而非「重新起播」——
    // 对应状态机 paused →(play)→ playing，不重新拉流（直播恢复不该重建 buffer）。
    if (input === undefined && this.hasLoaded) {
      await this.resumePlayback(hookCtx)
      return
    }
    await this.startPlayback(input, reqId, hookCtx)
  }

  /**
   * ② 恢复播放：**只唤醒媒体，不重新拉流**（对应状态机 paused →(play)→ playing；
   * 直播恢复不该重建 buffer）。
   *
   * 自行收尾钩子与 `COMMAND` 事件 —— 见 `play()` 的结构说明。
   */
  private async resumePlayback(hookCtx: CommandHookContext): Promise<void> {
    // 乐观更新：`playing` 事件是异步派发的，若等到 await 之后再改快照，
    // 调用方（含 PlayButton 的同步读取）会拿到过期的 playing=false。
    // 这里先同步纠正快照，失败时再回滚。
    this.playIntent = true
    this.mediaPaused = false
    this.state.set({ playing: true })
    try {
      await this.surface.play()
    } catch (err) {
      // 被中断（AbortError）视为正常竞态；被拦截（NotAllowedError）回滚后静默。
      if (this.handlePlayRejection(err)) {
        this.emitCommand('play', 'after', false)
        return
      }
      // 起播失败（如自动播放被拦截）：回滚快照与意图，交由接入方处理
      this.playIntent = false
      this.mediaPaused = true
      this.state.set({ playing: false })
      const e = this.makeError(ERROR_CODE.PLAY_FAILED, (err as Error).message, false)
      this.dispatchError(e)
      this.emitCommand('play', 'after', false)
      throw err
    }
    await this.hookAfter('play', hookCtx, true)
    this.emitCommand('play', 'after', true)
  }

  /**
   * ③ 起播新流：解析配置 → 重置会话与意图 → 建内核并加载。
   *
   * `reqId` 用来丢弃**已被更新的 `play()` 取代**的过期请求（before 钩子 await 期间可能又进来一次）。
   * 自行收尾钩子与 `COMMAND` 事件（三条失败/过期路径各自 `applied=false`）—— 见 `play()` 的结构说明。
   */
  private async startPlayback(input: PlayInput | undefined, reqId: number, hookCtx: CommandHookContext): Promise<void> {
    let cfg: PlayConfig
    try {
      cfg = await this.resolveConfig(input)
    } catch (err) {
      const e = this.makeError(ERROR_CODE.CONFIG_RESOLVE_FAILED, t(MSG.CONFIG_RESOLVE_FAILED, { detail: (err as Error).message }), true)
      this.dispatchError(e)
      this.emitCommand('play', 'after', false)
      throw err
    }
    if (reqId !== this.playRequestId) {
      this.emitCommand('play', 'after', false) // 过期请求忽略
      return
    }

    this.currentPlayConfig = cfg
    this.beginNewSession(cfg)

    try {
      const kernel = this.ensureKernel(cfg.url)
      await kernel.load(cfg.url)
      this.hasLoaded = true
      this.startLoadTimeout()
      this.applyLiveLatency()
    } catch (err) {
      this.dispatchError(this.makeError(ERROR_CODE.MANIFEST_LOAD_ERROR, (err as Error).message, false))
      this.emitCommand('play', 'after', false)
      throw err
    }
    await this.hookAfter('play', hookCtx, true)
    // 注：`autoplay: false` 时 applied 仍为 true —— 命令完成了它被要求的事（加载但不自动播），
    // 不是「空转」。要判断「是否真的开始播放」，看 `PlayerState.playing`。
    this.emitCommand('play', 'after', true)
  }

  /**
   * 把播放器重置到「新一轮会话」的起点（起播新流时调用一次）。
   *
   * 集中在一处的原因：这里的顺序**有依赖**，散在 `play()` 里时最容易改错 ——
   * 尤其是 `session.reset()` **必须早于** `stateMachine.transition('load')`：
   * 状态迁移会触发 `SessionMetrics.onTransition` 结算「进行中的 playing / stalled 时段」，
   * 若先迁移再重置，旧会话的尾巴就会被算进新会话。
   */
  private beginNewSession(cfg: PlayConfig): void {
    const muted = cfg.muted ?? this.config.muted ?? false
    this.surface.muted = muted
    this.applyPoster(cfg.poster)
    // 进度归零，等待 loadedmetadata / timeupdate 回填
    this.progressSecond = -1
    // 会话累计指标清零（须早于 transition('load')，见方法注释）
    this.session.reset()
    // 缓冲档位节流状态一并清零：新会话的第一份 bufferInfo 必须能派发出去，
    // 否则「起播瞬间的低缓冲」会因与上一轮档位相同而被静默吞掉。
    // 注：这是**缓冲观测**的游标，与会话指标无关，故不随 session 走。
    this.bufferLevel = -1
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
  }

  pause(): void {
    this.emitCommand('pause', 'before')
    this.surface.pause()
    // 显式暂停 = 用户意图转为「不播」，重连逻辑不应再把它还原为播放中
    this.playIntent = false
    // 乐观更新：浏览器 `pause` 事件是异步派发的，若只等事件，`getState().playing`
    // 在调用后仍为 true，UI 按钮/接入方同步读取会拿到过期状态。
    // 这里先行纠正快照，随后到达的 media `pause` 事件做幂等确认。
    this.mediaPaused = true
    if (this.state.get().playing) this.state.set({ playing: false })
    this.emitCommand('pause', 'after', true)
  }

  mute(m: boolean): void {
    this.emitCommand('mute', 'before')
    this.surface.muted = m
    this.state.set({ muted: m })
    this.emitCommand('mute', 'after', true)
  }

  setVolume(v: number): void {
    this.emitCommand('setVolume', 'before')
    this.surface.volume = v
    this.state.set({ volume: v })
    this.emitCommand('setVolume', 'after', true)
  }

  /**
   * 切换清晰度。前后会各派发一次 `'switchQuality'` 钩子（spec §3.6）——
   * before 阶段写回 `ctx.cancelled = true` 可拦截本次切换，after 阶段 `ctx.applied`
   * 告知是否真的切了（内核无 `qualitySwitch` 能力、或 `id` 不在档位表里时为 `false`）。
   */
  async switchQuality(id: number): Promise<void> {
    this.emitCommand('switchQuality', 'before')
    const ctx = this.hookCtx({ id })
    if (await this.hookBefore('switchQuality', ctx)) {
      // 被钩子拦截：命令已返回但**未生效**，因此补一次 applied=false 的 after
      this.emitCommand('switchQuality', 'after', false)
      return
    }

    let applied = false
    if (this.kernel?.capabilities.qualitySwitch) {
      if (id === -1) {
        // 恢复自动（ABR）
        this.kernel.switchQuality(-1)
        this.state.set({ currentQuality: null })
        this.emit(Events.ABR_CHANGE, { level: 'auto' })
        applied = true
      } else {
        const idx = this.quality.levelIndexOf(id)
        if (idx !== undefined) {
          this.kernel.switchQuality(idx)
          this.state.set({ currentQuality: id })
          this.emit(Events.QUALITY_CHANGE, { id })
          applied = true
        }
      }
    }
    await this.hookAfter('switchQuality', ctx, applied)
    this.emitCommand('switchQuality', 'after', applied)
  }

  /**
   * 运行中切流。前后各派发一次 `'switchURL'` 钩子 —— before 可拦截（如目标地址
   * 未通过校验时直接拒绝），after 在切流成功后触发。
   */
  async switchURL(url: string): Promise<void> {
    this.emitCommand('switchURL', 'before')
    if (this.destroyed || !this.kernel) {
      this.emitCommand('switchURL', 'after', false)
      throw new Error(t(MSG.KERNEL_NOT_INITIALIZED))
    }
    const ctx = this.hookCtx({ url })
    if (await this.hookBefore('switchURL', ctx)) {
      this.emitCommand('switchURL', 'after', false)
      return
    }
    try {
      await this.kernel.switchURL(url)
      if (this.currentPlayConfig) this.currentPlayConfig.url = url
      // 业务**主动**换源：不该再标记为「备用流中」（那是断流自动降级才有的状态）。
      // 但会话统计不重置 —— 换源属于同一次观看行为，切开会让观看时长/卡顿次数断裂。
      this.state.set({ usingBackup: false })
    } catch (err) {
      this.emitCommand('switchURL', 'after', false)
      this.dispatchError(this.makeError(ERROR_CODE.MANIFEST_LOAD_ERROR, (err as Error).message, false))
      throw err
    }
    await this.hookAfter('switchURL', ctx, true)
    this.emitCommand('switchURL', 'after', true)
  }

  /**
   * 请求全屏（TODO-9）。
   *
   * @param target 期望全屏的元素。缺省 = `<video>`（历史行为，兼容不变）。
   *
   * 传容器元素（例如 `player.root`，或业务自己的外层容器）则做**容器级全屏** ——
   * 自绘控件与默认 UI 控件栏都挂在容器内，容器全屏后它们仍可见可点；
   * 只全屏 `<video>` 时控件会消失（`<video>` 不能有子元素，其兄弟节点不在全屏范围内）。
   *
   * iOS Safari 不支持普通元素全屏时，自动回退原生视频全屏（控件不可见，但至少能全屏）；
   * 无任何全屏能力的环境静默降级（全屏非核心能力）。
   *
   * 无论全屏的是 video 还是容器，`PlayerState.fullscreen` 都会正确同步。
   */
  requestFullscreen(target?: Element): void {
    this.emitCommand('requestFullscreen', 'before')
    this.surface.requestFullscreen(target)
    this.emitCommand('requestFullscreen', 'after', true)
  }

  exitFullscreen(): void {
    this.emitCommand('exitFullscreen', 'before')
    this.surface.exitFullscreen()
    this.emitCommand('exitFullscreen', 'after', true)
  }

  /**
   * 定位到指定时间（秒），入参钳制到 `[0, duration]`。
   *
   * **直播中为 noop** —— 直播时间轴受 live edge 约束，任意定位只会持续累积延迟
   * （README「Non-Goals」）；点播 / 重播回放为正常用法。
   * 「是否直播」问**内核**（`Kernel.isLive`），不从 `duration` 反推 ——
   * MSE 路径下直播流的 `duration` 是有限的 playlist edge（见 `isLiveNow`）。
   */
  seek(time: number): void {
    this.emitCommand('seek', 'before')
    if (this.destroyed) {
      this.emitCommand('seek', 'after', false)
      return
    }
    if (this.isLiveNow()) {
      logger.debug(`[live-sdk] ${t(MSG.SEEK_LIVE_NOOP)}`)
      this.emitCommand('seek', 'after', false)
      return
    }
    const duration = this.surface.duration
    const upper = duration > 0 ? duration : time
    const target = Math.min(Math.max(time, 0), upper)
    this.surface.seek(target)
    // 乐观更新：`timeupdate` 是异步的（~4Hz），业务在 seek() 后同步读
    // getState().currentTime 会拿到旧值；此处先纠正快照与节流游标。
    this.progressSecond = Math.floor(target)
    this.state.set({ currentTime: target })
    this.emitCommand('seek', 'after', true)
  }

  /**
   * 设置倍速。**直播主场景不建议**（变速持续累积/消耗延迟、破坏边缘跟随）；
   * 点播 / 重播回放为正常用法。写后读回，快照反映浏览器实际生效值（可能被钳制）。
   */
  setPlaybackRate(rate: number): void {
    this.emitCommand('setPlaybackRate', 'before')
    if (this.destroyed) {
      this.emitCommand('setPlaybackRate', 'after', false)
      return
    }
    try {
      this.surface.playbackRate = rate
    } catch {
      logger.warn(`[live-sdk] ${t(MSG.RATE_INVALID, { rate })}`)
      this.emitCommand('setPlaybackRate', 'after', false)
      return
    }
    this.state.set({ playbackRate: this.surface.playbackRate })
    this.emitCommand('setPlaybackRate', 'after', true)
  }

  /** 运行时更换封面（`undefined` / 空串 = 移除）；呈现方式仍由 `PlayerConfig.posterMode` 决定。 */
  setPoster(poster?: string): void {
    this.emitCommand('setPoster', 'before')
    this.applyPoster(poster)
    this.emitCommand('setPoster', 'after', true)
  }

  /**
   * 运行时覆盖 LL-HLS 目标延迟（秒）。传空 = 清除本次覆盖、恢复 `config.network`
   * 的动态策略；内核无 `setLiveLatency` 能力时静默忽略。
   */
  setLiveLatency(target?: number, max?: number): void {
    this.emitCommand('setLiveLatency', 'before')
    this.latencyOverride = target === undefined && max === undefined ? null : { target, max }
    // `applyLiveLatency` 在内核无该能力时直接 return（静默忽略）——如实回报 applied=false，
    // 接入方据此知道「这条命令在当前内核上没作用」，而不是以为设置成功了。
    const applied = typeof this.kernel?.setLiveLatency === 'function'
    this.applyLiveLatency()
    this.emitCommand('setLiveLatency', 'after', applied)
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
        logger.warn(`[state] ${t(MSG.APP_STATE_KEY_IGNORED, { key: k })}`)
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

  /**
   * 该**媒体设备**能否播放给定 MIME（如 `'application/vnd.apple.mpegurl'`）。
   *
   * 取代原先从主入口导出的 `sniffer.canPlayNativeHLS` / `canPlayNativeMP4` ——
   * 它们是媒体设备能力，现在由平台契约 `MediaSurface.canPlay()` 回答，core 只做转发、**不解释结果**
   * （非 Web 宿主由宿主自己回答，不必让平台外推 Web 的 `canPlayType` 语义，见 spec §3.9）。
   *
   * ⚠️ 注意不要与 `player.media.canPlayType()` 混：`player.media` 是**原生媒体句柄**
   * （Web 即 `HTMLVideoElement`，值是裸字符串三态），本方法返回的是**收敛后的布尔**，
   * 且换宿主后依然可用。
   *
   * 典型用途：决定「是否提示换浏览器 / 打开 App」，或自建内核选路。
   */
  canPlay(type: string): boolean {
    return this.surface.canPlay(type)
  }

  getStats(): StatsInfo {
    return this.kernel?.getStats() ?? {}
  }

  bufferInfo(): BufferInfo {
    return this.kernel?.bufferInfo() ?? { buffers: [], behind: 0, remaining: 0, length: 0, totalRemaining: 0, totalLength: 0 }
  }

  /**
   * 缓冲水位的**事件侧**（`bufferInfo()` 是查询侧）。
   *
   * 触发时机：media `progress`（缓冲区间变化）。
   * 派发判据：**档位跨越** —— 把「当前播放块剩余可播时长」映射到 `BUFFER_LEVEL_THRESHOLDS`
   * 定义的离散档位，只有在档位与上次派发不同时才 `emit`。
   *
   * 两个设计取舍：
   * 1. **按 `remaining`（当前块）而非 `totalRemaining`（全量并集）分档** ——
   *    判定「还能不能连续播下去」只取决于当前块；孤岛场景下 buffer 里囤着 30s 但当前块
   *    只剩 0.5s 时，真正会发生的是卡顿，不是「缓冲充裕」。
   * 2. **完整载荷**：`BufferInfo` 每个字段都带上（含 `totalRemaining` / `behind`），
   *    所以按并集口径或延迟口径判定的接入方也能只靠这一个事件工作。
   *
   * 首帧前也允许派发 —— 起播阶段的缓冲爬升正是「起播慢」诊断需要的信号。
   */
  private checkBufferLevel(): void {
    const info = this.bufferInfo()
    const level = bufferLevelOf(info.remaining)
    if (level === this.bufferLevel) return
    this.bufferLevel = level
    const payload: BufferUpdatePayload = { ...info, level }
    this.emit(Events.BUFFER_UPDATE, payload)
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
    return this.session.report()
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
      this.matchFeature(feature, client[feature], this.quality.serverState(feature)),
    )
    const matched = features.filter((f) => f.matched).length
    return { features, summary: { matched, mismatched: features.length - matched } }
  }

  /** 客户端侧能力是否「可用」：`degraded`=平台接管仍可用（如原生回退投屏）。 */
  private isClientUsable(state: SideState): boolean {
    return state === 'supported' || state === 'degraded'
  }

  /** 服务端侧是否「可用」：只有 `supported` 算满足；`unknown`=尚未探测，不算可用。 */
  private isServerUsable(state: SideState): boolean {
    return state === 'supported'
  }

  /**
   * 计算单条特性的端到端对齐结果（spec §4.7）。
   *
   * `matched` 的统一口径 = 客户端可用 **且** 服务端可用。**不为 `airplay` 开特例**——
   * 它「无服务端依赖」这件事改由 `server` 恒为 `supported` 来表达
   * （见 `QualityController#probeServer`），而不是在匹配逻辑里绕过服务端判据
   * （旧实现的 bug：`server=unknown` 却 `matched=true`）。
   *
   * 原 `utils/features.ts`（`matchFeature` + 上面两个判据）：该模块**唯一的生产消费者**
   * 就是 `getFeatureStatus()`，故三个函数一并并入本类。
   *
   * ⚠️ **并入的代价（已知并接受）**：这些分支不再能被「直接调用纯函数」那样逐格覆盖，
   * 只能经 `getFeatureStatus()` 的**可达组合**断言。三种组合在生产路径上不可能出现，
   * 因此不再有对应用例：`client='unknown'`（`getFeatureStatus` 只产出
   * supported/absent/degraded）、`server='degraded'`（`probeServer` 只产出
   * supported/absent/unknown）、`airplay` 的 `server='absent'`（它恒为 `supported`）。
   * 详见 `docs/implementation.md` §8.22。
   */
  private matchFeature(feature: FeatureKey, client: SideState, server: SideState): FeatureStatus {
    const clientUsable = this.isClientUsable(client)
    const serverUsable = this.isServerUsable(server)
    const matched = clientUsable && serverUsable

    let detail: string | undefined
    if (!matched) {
      detail = !clientUsable
        ? t(MSG.FEATURE_CLIENT_UNSUPPORTED)
        : !serverUsable
          ? t(MSG.FEATURE_SERVER_ABSENT)
          : t(MSG.FEATURE_MISMATCH)
    } else if (client === 'degraded') {
      detail = t(MSG.FEATURE_NATIVE_FALLBACK)
    }
    return { feature, client, server, matched, detail }
  }

  // ═══════════════ 插件 / 钩子 ═══════════════

  /**
   * 注册插件：**构造器或实例皆可**（§3.6）。
   * - `registerPlugin(MyReporter, { endpoint })` —— 传构造器，由 SDK 实例化
   * - `registerPlugin(new MyReporter(), { endpoint })` —— 传实例，业务可预先持有引用
   *
   * 两种形态都会走 `create(player)` → `init(config)`，业务不要自行预先 register。
   */
  registerPlugin(plugin: PluginInput, config?: unknown): Plugin {
    return this.addPlugin(plugin, config)
  }

  /**
   * 注册插件，且**内核已就绪时立即补调 `ready()`**（`registerPlugin` 与 `applyPreset` 共用）。
   *
   * 为什么不把这个判断放回 `PluginManager`：① 「此刻算不算就绪」是 `Player` 的知识，
   * 它只该管插件集合与生命周期广播；② 更要紧的是，让 `PluginManager` 反向读
   * `player.kernelReady` 会逼那个字段放弃 `private`（TS 按类封装，兄弟类算外部）——
   * 它此前正是这样泄漏进 `.d.ts` 的。详见 `PluginManager` 的类注释。
   */
  private addPlugin(input: PluginInput, config?: unknown): Plugin {
    const instance = this.plugins.add(input, config)
    if (this.kernelReady) this.plugins.readyOne(instance)
    return instance
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

  /**
   * 跑一轮钩子。**内部方法**：`HookFn` 的返回值没有回传通道，决策经可变 `ctx` 传递
   * （见 `hookBefore`）；对外只暴露 `useHooks` 注册，不需要接入方手动触发。
   */
  private async runHooks(name: string, ctx: Record<string, unknown>): Promise<void> {
    await this.hooks.run(name, ctx)
  }

  /**
   * 构造命令钩子上下文。初始 `phase` 取 `'before'` —— 它总会被 `hookBefore` / `hookAfter`
   * 覆盖，这里只是为了让类型完整（钩子真正执行时两个字段必定就位）。
   */
  private hookCtx(extra: Record<string, unknown> = {}): CommandHookContext {
    return { phase: 'before', cancelled: false, ...extra }
  }

  /**
   * 命令的 **before** 钩子（spec §3.6）。返回 `true` = 本次操作被接入方拦截，内置逻辑应当跳过。
   *
   * 拦截协议：钩子通过**写回 `ctx.cancelled = true`** 表达取消（`HookFn` 的返回值是 `void`，
   * 没有回传通道，故约定用可变 ctx 传递决策）。`ctx.phase` 恒为 `'before'`，便于同一个
   * 处理器同时挂 before/after 时分支。
   *
   * 每次调用前重置 `cancelled` —— 防止上一次被拦截的残留值误伤本次调用。
   */
  private async hookBefore(name: string, ctx: CommandHookContext): Promise<boolean> {
    ctx.phase = 'before'
    ctx.cancelled = false
    await this.runHooks(name, ctx)
    // 必须放宽类型后再判定：上面 `ctx.cancelled = false` 会把该属性窄化成字面量 `false`，
    // 直接比较 `=== true` 会触发 TS2367（"类型 false 与 true 无重叠"）。
    // 钩子在运行时是能改写它的，编译器看不到 —— 这正是「编译期把不变式钉死」的用法。
    const cancelled: unknown = ctx.cancelled
    return cancelled === true
  }

  /**
   * 命令的 **after** 钩子。`applied` 告知内置逻辑是否**真的做了事**
   * （如 `switchQuality` 遇到内核不支持、或 `id` 不在档位表里时为 `false`）——
   * 钩子据此区分「操作生效了」与「操作被解析后判定为 no-op」。
   *
   * 只在操作**正常结束**时触发；抛错路径不触发（错误本身已由 `ERROR` 事件承载）。
   */
  private async hookAfter(name: string, ctx: CommandHookContext, applied: boolean): Promise<void> {
    ctx.phase = 'after'
    ctx.applied = applied
    await this.runHooks(name, ctx)
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
    const polling = this.livePolling()
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
    if (this.surface.isFullscreen()) this.surface.exitFullscreen()
    // 清理定时器
    for (const t of this.timers) clearTimeout(t)
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
    // 媒体面先销毁（暂停 + 释放媒体资源），再由承载面拆掉根节点与封面图层
    this.surface.destroy()
    this.host.destroy()
    this.state.destroy()
    this.hooks.destroy()
    this.eventBus.removeAll()
  }

  // ═══════════════ 内部：配置解析 ═══════════════

  private async resolveConfig(input?: PlayInput): Promise<PlayConfig> {
    let raw: PlayInput
    if (input === undefined) {
      if (!this.config.url) throw new Error(t(MSG.NO_PLAY_URL))
      raw = this.config.url
    } else {
      raw = input
    }
    let cfg: PlayConfig
    if (typeof raw === 'string') cfg = { url: raw }
    else if (typeof raw === 'function') cfg = await raw()
    else cfg = raw
    if (!cfg || !cfg.url) throw new Error(t(MSG.PLAY_URL_MISSING))
    return cfg
  }

  // ═══════════════ 内部：内核选路与创建 ═══════════════

  private ensureKernel(url: string): Kernel {
    if (this.kernel) return this.kernel
    const Ctor = this.selectKernel(url)
    const kernel = new Ctor({
      // 内核拿到的是**平台原生媒体句柄**（Web 即 HTMLVideoElement）——
      // 这是 Kernel 契约既有的形状，本阶段未改（见 spec §3.10 的后续项）
      media: this.media,
      hlsConfig: this.config.hlsConfig,
      observability: this.config.observability,
      onEvent: (event, data) => this.handleKernelEvent(event, data),
    })
    this.kernel = kernel
    this.state.set({ capabilities: kernel.capabilities })
    return kernel
  }

  /**
   * 内核选路：`= f(源格式, 平台能力, 观测档位)`（spec §7.2）。
   *
   * **默认内核的选择属于平台**：`HlsKernel` / `NativeKernel` 以及平台能力探测
   * 全部搬到了 `src/platform/web/selectKernel.ts`（P0 解耦），core 只保留一条
   * 平台无关的判断 —— **接入方显式指定 `config.kernel` 时优先**。
   */
  private selectKernel(url: string): KernelConstructor {
    if (this.config.kernel) return this.config.kernel
    return this.platform.selectKernel(url, this.config.observability)
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
    // 服务端能力声明：由清单载荷 + 当前 level 数量推导（内核只在此处被读一次）
    this.quality.probeServer(data, this.kernel?.getLevels?.()?.length ?? 0)
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
    // 媒体事件一律经 `MediaSurface.on` 订阅 —— core 不再写 `el.addEventListener`
    // （否则等于把「媒体是 DOM 元素」写回 core；这条是平台接缝测试发现的）。
    //
    // 本方法只保留「事件名 → 处理」的对照，力求一眼看完我们监听了哪些事件；
    // **非平凡的处理逻辑一律提为具名方法**（`onMediaEnded` / `onMediaVolumeChange` /
    // `onMediaRateChange` / `onNativeMediaError`），与既有的 `onMediaPlay` / `onMediaPlaying` /
    // `onMediaPause` / `onStall` 保持同一形状 —— 名字比内联块更能承载领域知识。
    const on = (name: MediaEventName, fn: () => void) => {
      this.disposedSubs.push(this.surface.on(name, fn))
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
    // 缓冲水位：挂 `progress`（缓冲区间变化时由媒体设备派发），而非 `timeupdate`。
    // 派发本身由档位跨越判定节流，见 checkBufferLevel()。
    on('progress', () => this.checkBufferLevel())
    // `play` 与下面的 `playing` 是两件事：前者=请求被接受（尚未出画），后者=真的在播。
    on('play', () => this.onMediaPlay())
    on('playing', () => this.onMediaPlaying())
    on('pause', () => this.onMediaPause())
    on('waiting', () => this.onStall())
    on('stalled', () => this.onStall())
    on('ended', () => this.onMediaEnded())
    on('volumechange', () => this.onMediaVolumeChange())
    on('ratechange', () => this.onMediaRateChange())
    on('error', () => this.onNativeMediaError())

    // —— 全屏状态同步 ——
    // **两个来源在平台侧合一**：Web 的「`document` 上的标准/前缀 fullscreenchange」
    // 与「iOS 原生视频全屏的 `webkitbegin/endfullscreen`（不派发 fullscreenchange）」。
    // core 只认 `fullscreenchange` 一个事件名，也不必知道 `document` 的存在。
    on('fullscreenchange', () => this.syncFullscreen())
  }

  /**
   * 播放结束（媒体自然播完）。
   *
   * `playIntent = false` 是关键：**播完 = 用户意图终止**，重连逻辑不得把它复活
   * （否则近尾结束会被当成断流，触发无意义的重连）。
   *
   * **直播例外 —— 原生 `ended` 不等于「直播结束」**：MSE 路径下内核把 `duration` 写成
   * playlist edge（见 `isLiveNow`），流一旦停止更新（断播 / 严重落后），播放点会线性追到
   * 该值，浏览器随即派发原生 `ended` —— 且此后**不会自行恢复**（ended 后媒体保持暂停，
   * 须显式 `play()` 或重载）。
   * 所以直播中不能按「播完」处理（会让业务显示结束态、并停掉重连），也不宜按普通卡顿
   * 等待自愈（`loadTimeout` 默认 8–20s，而 `ended` 是确定性信号，不是「数据还在路上」）
   * —— 直接走断流恢复。
   * 判据同样走 `isLiveNow()`：直播结束（playlist 出现 `#EXT-X-ENDLIST`）后内核会翻转，
   * 那时缓冲播完的原生 `ended` 才是真的结束，照常派发 `ENDED`。
   */
  private onMediaEnded(): void {
    if (this.isLiveNow()) {
      logger.debug(`[live-sdk] ${t(MSG.LIVE_ENDED_NATIVE)}`)
      this.recover(ERROR_CODE.NETWORK_ERROR, t(MSG.LIVE_STREAM_STALLED))
      return
    }
    this.playIntent = false
    this.mediaPaused = true
    this.stateMachine.transition('ended')
    this.emit(Events.ENDED)
  }

  /** 音量 / 静音变化（含外部直接操作媒体）→ 跟随同步到快照。 */
  private onMediaVolumeChange(): void {
    this.state.set({ volume: this.surface.volume, muted: this.surface.muted })
  }

  /** 倍速也可能被外部（直接操作媒体）改动：跟随同步并去重，避免重复渲染。 */
  private onMediaRateChange(): void {
    const rate = this.surface.playbackRate
    if (rate !== this.state.get().playbackRate) this.state.set({ playbackRate: rate })
  }

  /**
   * 原生媒体错误（`NativeKernel` / 渐进式直连路径）。
   *
   * `<video>.error` 是 `MediaError`，其 `code` 是规范里的**定值枚举**、语义可靠 → 按 code 分派
   * （详见 `utils/errors.ts#mapMediaErrorCode`）。
   * 早期实现一律映射成 `network_error`，会把解码 / 格式类错误打进「接口与 CDN」，
   * 使接入方按错误码做的分类上报整体错位。
   */
  private onNativeMediaError(): void {
    const mediaError = this.surface.error()
    const mapped = mapMediaErrorCode(mediaError?.code, mediaError?.message)
    if (!mapped) return // code=1：换源 / 销毁引发的中止，不是故障
    this.dispatchError(this.makeError(mapped.code, mediaError?.message || t(MSG.MEDIA_LOAD_FAILED), mapped.fatal))
  }

  /** 把全屏真实状态同步到快照（去重后写，避免重复事件驱动无意义的重渲染）。 */
  private syncFullscreen(): void {
    const full = this.surface.isFullscreen()
    if (full !== this.state.get().fullscreen) this.state.set({ fullscreen: full })
  }

  /**
   * media `play` 事件 → `PLAY`。
   *
   * 与 `onMediaPause` 严格对称（那边派发 `PAUSE`）—— 这一对称性本身就是它此前
   * 缺失的证据：`PAUSE` 有 DOM 事件源而 `PLAY` 没有，属于接线漏了一半。
   *
   * 语义边界（与 HTMLMediaElement 原生事件语义一致，不要混用）：
   * - `PLAY`    = 播放**请求**已被内核接受（`paused` 已转 false），**尚未渲染首帧**；
   * - `PLAYING` = 媒体已真正开始输出（`onMediaPlaying`），首帧后每次起播都会派发。
   *
   * 因此自动播放成功、断线重连后恢复、二次 `play()` 都会各派发一次 `PLAY`。
   * **不做初始化期噪声抑制**：`play` 事件只在 `paused` 由 true 变 false 时产生
   * （不象 `pause` 会被 MSE attach 的 AbortError 连带触发），它每次都对应一次真实意图。
   */
  private onMediaPlay(): void {
    this.emit(Events.PLAY)
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
    const timer = setTimeout(() => {
      if (this.stateMachine.current === 'stalled') {
        // 超时前再判一次近尾：解码器可能在等待期间才补完最后一帧
        if (this.isNearTail()) {
          this.playIntent = false
          this.mediaPaused = true
          if (this.stateMachine.transition('ended')) this.emit(Events.ENDED)
          return
        }
        this.stateMachine.transition('timeout')
        this.recover(ERROR_CODE.LOAD_TIMEOUT, t(MSG.BUFFER_STALL_TIMEOUT))
      }
    }, timeout)
    this.addTimer(timer)
  }

  /**
   * 当前是否仍在直播（时间轴还在增长）。
   *
   * **优先问内核**（`Kernel.isLive?()`）。靠 `duration` 是否有限来判断是**不成立**的：
   * 原生 HLS（`NativeKernel`）直播下确为 `Infinity`，但 MSE 路径下 hls.js 默认
   * （`liveDurationInfinity: false`）会把直播流的 `MediaSource.duration` 写成 playlist edge
   * —— **有限值**，且随滑窗递增，与点播在 `duration` 上无法区分。
   * 内核未实现该扩展方法时回退到旧判据，保持向后兼容（见 `types.ts#Kernel.isLive`）。
   */
  private isLiveNow(): boolean {
    const kernel = this.kernel
    if (kernel?.isLive) return kernel.isLive()
    return !Number.isFinite(this.surface.duration)
  }

  /**
   * 是否处于「近尾」：当前播放点之后已缓冲到媒体末尾，且距末尾在容差内。
   * 直播中恒为 false，避免把正常缓冲误判为播完。
   * 容差取 max(0.5s, 最后区间长度的小比例)，兼顾正常结尾与异常流的时长偏差。
   */
  private isNearTail(tolerance = 0.5): boolean {
    // 直播中不存在「播完」。这里必须走内核判据：MSE 路径下直播流的 `duration` 是有限的
    // playlist edge，旧判据会漏进来 —— 低延迟直播里「延迟已压进容差 + buffer 到 edge」
    // 就会被判成近尾，`onStall()` 据此停止重连并派发 `ENDED`（业务看到「直播已结束」）。
    if (this.isLiveNow()) return false
    const duration = this.surface.duration
    if (!Number.isFinite(duration) || duration <= 0) return false // 元数据未就绪
    const buffers = this.surface.buffered()
    if (buffers.length === 0) return false
    const bufferEnd = buffers[buffers.length - 1]![1]
    // buffer 已到末尾（允许极小误差）+ 播放点也贴近末尾
    const bufferAtEnd = duration - bufferEnd <= tolerance
    const playAtEnd = duration - this.surface.currentTime <= Math.max(tolerance, 1)
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
   * - `session.markFirstFrame()`：本轮会话的首帧耗时 —— **每次起播都要重新计**；
   * - `emitFirstFrame()`：`FIRST_FRAME` 事件 + `plugins.readyAll()` —— 历史行为是
   *   **一次性闸门、二次起播不重置**（它兼作「插件可以开始工作了」的就绪信号，
   *   重复派发没有意义，且 `applyPoster` 的隐藏逻辑依赖这个特性）。
   *
   * 早期实现只调 `emitFirstFrame()`，于是「切档 / 换源后重新起播」这条路径上闸门已关，
   * 永远不会记录首帧耗时（`firstFrameCost` 停在 null）。两者必须分开。
   */
  private onFirstFrameSignal(): void {
    this.session.markFirstFrame()
    this.emitFirstFrame()
  }

  // ═══════════════ 内部：接入期自检 ═══════════════

  /**
   * 容器零尺寸告警（**每个实例只报一次**）。
   *
   * 「接入后画面不显示」最常见的原因就是**容器没有高度**：`width/height: 100%` 的元素
   * 在父级未给出确定高度时高度即为 0。此时 SDK 侧一切正常——`play()` 成功、没有 error 事件、
   * 内核在拉流——但一个像素都看不见，接入方往往要排查很久。
   *
   * 两个约束：
   * - **只报一次**：`play()` 会被多次调用，重复告警等于噪声；
   * - **测量不到就不报**：非浏览器环境与自建 DOM 替身没有 `getBoundingClientRect` /
   *   `offsetWidth`，把它们当成 0 会满屏误报（见 `readElementSize`）。
   *
   * **只在 `play()` 时检查，不在构造时检查**：构造时容器合法为 0 的场景很常见
   * （未激活的 tab、路由过渡中的 `display:none`、懒挂载），那时告警误报率过高；
   * 而「起播这一刻仍然没有尺寸」才是真正值得提示的信号。
   */
  private warnIfZeroSize(): void {
    if (this.sizeWarned || this.destroyed) return
    const size = this.host.measure() // 平台测量；测不到返回 null（与「真的是 0」区分）
    if (!size || !isZeroSized(size)) return
    this.sizeWarned = true
    // 排查提示是**平台相关**的（Web 给 CSS 例子，其他宿主写法不同）→ 由平台包提供
    const hint = this.platform.zeroSizeHint ? ` ${this.platform.zeroSizeHint}` : ''
    logger.warn(t(MSG.ZERO_SIZE_WARNING, { width: size.width, height: size.height, hint }))
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
      this.surface.poster = poster
      return
    }
    // overlay 模式不写 video.poster，避免与图层重复呈现
    if (!poster) {
      this.host.hidePosterOverlay()
      return
    }
    // 图层怎么建（Web 用 `<img>`，其他宿主用自家组件）由承载面决定 —— core 不碰 DOM
    this.host.showPosterOverlay(poster)
    // 注意：不要重置 firstFrameEmitted —— 它还兼作 plugins.readyAll()/kernelReady 的一次性闸门。
    // 二次起播时 emitFirstFrame 不再触发，改由 onMediaPlaying（playing 事件，每次起播都会派发）兜底隐藏。
  }

  /** 隐藏封面图层（幂等）。首帧呈现、进入播放时调用。 */
  private hidePosterOverlay(): void {
    this.host.hidePosterOverlay()
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
    const t = this.surface.currentTime || 0
    const second = Math.floor(t)
    const raw = this.surface.duration
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
      logger.warn(`[live-sdk] ${t(MSG.AUTOPLAY_BLOCKED)}`)
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
    const p = this.surface.play()
    if (!p || typeof p.catch !== 'function') return
    p.catch((err) => {
      if (this.handlePlayRejection(err)) return
      this.dispatchError(this.makeError(ERROR_CODE.UNKNOWN, t(MSG.PLAY_FAILED, { detail: (err as Error).message }), false))
    })
  }

  private onStateChange(next: SessionState): void {
    if (next === 'paused' || next === 'playing') this.mediaPaused = next === 'paused'

    // 会话级累计指标（进入 / 离开 playing、stalled 的收口与结算）全部交给 SessionMetrics。
    // 关键设计仍在那里：**离开路径统一结算**，而不是只在 RECOVERED 里累加 —— 详见其注释。
    this.session.onTransition(next)

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
    return {
      code,
      // 域由错误码派生（见 ERROR_DOMAIN）：接入方直接读 err.domain 做分流，
      // 不必自己维护「错误码 → 方向」映射表（那样必然随 ERROR_CODE 新增而失同步）。
      domain: errorDomainOf(code),
      message,
      fatal,
      retryCount: this.retryCount,
      diagnostic: diagnostic ?? this.lastRetryDiagnostic ?? undefined,
    }
  }

  /**
   * 派发命令观测事件（`COMMAND`，见 `CommandEventPayload`）。
   * 每个命令在进入实现前派 `'before'`、返回前派 `'after'`，**成对**。
   */
  private emitCommand(name: CommandName, phase: HookPhase, applied?: boolean): void {
    this.emit(Events.COMMAND, { name, phase, applied, time: Date.now() })
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
      // `domain` 必须一并带上：上报通道与事件通道**信息应对等**。
      // 只给事件通道加 domain（err.domain），会让走上报通道的接入方（自定义 reporter）
      // 又得自己按 code 映射一遍 —— 那正是 0.5.0 加错误域要消掉的事。
      data: { message: out.message, domain: out.domain, retryCount: out.retryCount, diagnostic },
      time: Date.now(),
    })
    if (out.fatal) {
      this.clearLoadTimeout()
      this.stateMachine.transition('error')
      return
    }
    this.recover(out.code, out.message)
  }

  /** 上一次**放行**的错误（`{ code, time }`）—— 被抑制时**不更新**它，见下。 */
  private lastErrState: DedupState = { code: '', time: 0 }

  /**
   * 同类错误节流去重（10s 窗口）。
   *
   * 设计意图（勿改）：直播断流往往是「同一故障的连续外化」，内核会成串抛出同类错误。
   * 若逐条透出，接入方的 Sentry 会被同一条错误刷屏，且每一条都会触发一次重连——
   * 这正是「重试风暴」。因此同一 code 在窗口内只放行第一条。
   *
   * 三条边界（都有单测锚定，见 `test/player.test.ts` 的退避/去重用例）：
   * - 不同 code 互相不抑制 —— 换了个错误说明故障变了，必须放行；
   * - 窗口外同一 code 再次出现也放行 —— 说明故障复发，需要重新上报；
   * - **抑制路径不得刷新窗口起点**（只有放行路径才写 `state`）——
   *   否则连续刷屏的同类错误会把窗口无限顺延，故障永远不会「复发上报」。
   *
   * 原 `utils/retry.ts#shouldDedupError`：唯一消费者就是本类，故并入；`now` 由原来的显式
   * 入参改为就地读 `Date.now()`（测试经 `vi.setSystemTime` 控制时钟）。
   */
  private lastErrorDedup(err: PlayerError): boolean {
    const state = this.lastErrState
    const now = Date.now()
    if (state.code === err.code && now - state.time < ERROR_DEDUP_WINDOW_MS) return true
    state.code = err.code
    state.time = now
    return false
  }

  /**
   * 指数退避 + 抖动（断流重连的等待时长）。
   *
   * 公式：`base * 2^(retryCount-1) + Math.random() * base`，`retryCount` 从 1 开始。
   * - `2^(n-1)` 提供指数增长，避免固定间隔在服务端故障时形成共振；
   * - `[0, base)` 的抖动打散多端同时重连（惊群）。
   *
   * 原 `utils/retry.ts#computeRetryDelay`（唯一消费者就是本类，故并入）。它原先带一个
   * `random` 注入参数供单测控制抖动；**私有化后不再有注入点**，测试改为 spy 全局
   * `Math.random` —— 效果等价，且少一个只为测试存在的参数。
   */
  private computeRetryDelay(base: number, retryCount: number): number {
    return base * Math.pow(2, retryCount - 1) + Math.random() * base
  }

  private recover(code: string, message: string): void {
    if (this.stateMachine.current === 'stalled') this.stateMachine.transition('timeout')
    else this.stateMachine.transition('error')

    const max = this.resolveTunable(this.config.network.retryCount)
    if (this.retryCount >= max) {
      this.dispatchError(
        this.makeError(
          ERROR_CODE.RETRY_EXHAUSTED,
          t(MSG.RETRY_EXHAUSTED, { max, code }),
          true,
          this.buildDiagnostic(code, 0),
        ),
      )
      return
    }
    this.retryCount++
    const base = this.resolveTunable(this.config.network.retryDelay)
    const delay = this.computeRetryDelay(base, this.retryCount)
    const diagnostic = this.buildDiagnostic(code, delay)
    logger.warn(`[live-sdk] ${t(MSG.RETRY_START)}`, diagnostic)
    this.emit(Events.RETRY, { code, retryCount: this.retryCount, delay, diagnostic })
    // 诊断快照**嵌套在 `diagnostic` 下**，与 error 记录保持同一形状 ——
    // 早先这里是 `{ message, ...diagnostic }`（平铺），导致同一条文档承诺
    // 「`ReportRecord.data.diagnostic` 含快照」在重连路径上不成立：
    // 消费方按 `data.diagnostic` 取会拿到 undefined，只能靠推断去读一堆平铺字段。
    this.dispatchReport({ type: 'event', code: 'retry', level: 'warn', data: { message, diagnostic }, time: Date.now() })
    this.stateMachine.transition('retry')
    const timer = setTimeout(() => this.reload(code, diagnostic), delay)
    this.addTimer(timer)
  }

  private reload(code: string, diagnostic?: RetryDiagnostic): void {
    if (this.destroyed || !this.currentPlayConfig) return
    const cfg = this.currentPlayConfig
    const useBackup = !!cfg.backup && this.retryCount === 1
    const url = useBackup ? (cfg.backup as string) : cfg.url
    const diag = this.buildDiagnostic(code, diagnostic?.delay ?? 0, url)
    logger.warn(`[live-sdk] ${t(MSG.RETRY_ATTEMPT, { count: this.retryCount, code, url })}`, diag)
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
      currentTime: Number((this.surface.currentTime || 0).toFixed(2)),
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
    this.livePolling()?.stop()
  }

  private onForeground(): void {
    // 回前台：检查并续播（结合断流重连）
    if (this.stateMachine.current === 'error' || this.stateMachine.current === 'stalled') {
      this.recover(ERROR_CODE.NETWORK_ERROR, t(MSG.FOREGROUND_RECOVER))
    } else if (this.currentPlayConfig?.liveStatus) {
      this.livePolling()?.start(this.currentPlayConfig.liveStatus)
    }
  }

  private onOffline(): void {
    logger.warn(`[live-sdk] ${t(MSG.NETWORK_OFFLINE)}`)
  }

  // ═══════════════ 内部：清晰度映射（§4.3） ═══════════════

  /**
   * 重建档位映射并写入快照。
   *
   * 映射规则（height 主键 → bitrate 最近邻 → 剔除）与失败告警都在
   * `QualityController.syncLevels()` 里，本方法只负责「取两个入参 + 写快照」。
   */
  private updateQualities(): void {
    const business = this.currentPlayConfig?.quality ?? []
    const levels = this.kernel?.getLevels?.() ?? []
    if (levels.length === 0) {
      this.quality.syncLevels(business, levels) // 清空映射
      this.state.set({ qualities: [], currentQuality: null })
      return
    }
    this.state.set({ qualities: this.quality.syncLevels(business, levels) })
  }

  // ═══════════════ 内部：直播轮询 ═══════════════

  private startLivePollingIfNeeded(): void {
    const url = this.currentPlayConfig?.liveStatus
    if (!url) return
    this.livePolling()?.start(url)
  }

  // ═══════════════ 内部：预设 / 上报 / 定时器 ═══════════════

  /**
   * 取直播状态轮询插件（按名字装配、按行为形状使用）。
   *
   * 这里有一次**显式收窄**：`PluginManager.get` 的泛型上界是 `Plugin`（完整插件生命周期），
   * 而 core 只需要它的两个行为方法 —— 用 `LivePollingLike` 表达「core 对该插件的全部了解」。
   * 代价是一次 cast，换来 core 不必 `import` 实现层的 `LivePolling`（见 `verify/layers.mjs`）。
   */
  private livePolling(): LivePollingLike | undefined {
    return this.plugins.get('livePolling') as unknown as LivePollingLike | undefined
  }

  /**
   * 应用插件预设（`config.preset`）。
   *
   * **具名预设的具体成员属于平台**：`live` / `vod` 各含哪些插件由平台包提供
   * （Web: `ConsoleReporter` + `LivePolling`）。core 只负责「按名字取列表 + 过滤 ignores + 装配」，
   * 因此这里不再 `import` 任何插件类。
   */
  private applyPreset(): void {
    const preset = this.config.preset
    const ignores = this.config.ignores ?? []
    let list: PluginPresetEntry[] = []
    if (Array.isArray(preset)) {
      list = preset as unknown as PluginPresetEntry[]
    } else if (typeof preset === 'string' && this.platform.presets[preset]) {
      list = this.platform.presets[preset]
    }
    for (const Ctor of list) {
      if (ignores.includes(Ctor.pluginName)) continue
      this.addPlugin(Ctor as never)
    }
  }

  private dispatchReport(record: ReportRecord): void {
    for (const p of this.plugins.all()) {
      const rp = p as unknown as { report?: (r: ReportRecord) => void }
      try {
        rp.report?.(record)
      } catch (err) {
        logger.error(`[live-sdk] ${t(MSG.REPORTER_THREW)}`, err)
      }
    }
  }

  private startLoadTimeout(): void {
    this.clearLoadTimeout()
    const timeout = this.resolveTunable(this.config.network.loadTimeout)
    const timer = setTimeout(() => {
      if (this.stateMachine.current === 'loading') {
        this.dispatchError(this.makeError(ERROR_CODE.LOAD_TIMEOUT, t(MSG.LOAD_TIMEOUT, { ms: timeout }), false))
      }
    }, timeout)
    this.loadTimeoutTimer = timer
    this.addTimer(timer)
  }

  private clearLoadTimeout(): void {
    if (this.loadTimeoutTimer !== null) {
      clearTimeout(this.loadTimeoutTimer)
      this.timers.delete(this.loadTimeoutTimer)
      this.loadTimeoutTimer = null
    }
  }

  private addTimer(t: number): void {
    this.timers.add(t)
  }
}
