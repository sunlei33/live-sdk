import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installDom, makeEl, makeTimeRanges, type FakeMediaElement } from './fixtures/dom'
import { ERROR_CODE, COMMAND_NAMES, ERROR_DOMAIN, DEFAULT_LOCALE } from '../src/constants'
import { getLocale, setLocale } from '../src/utils/i18n'

type Dom = ReturnType<typeof installDom>
type PlayerInstance = import('../src/core/Player').Player

let dom: Dom
let video: FakeMediaElement
let PlayerCtor: typeof import('../src/core/Player').Player
/** P0：`Player` 需注入平台装配包；测试用真实 Web 实现（动态导入，等 DOM 就绪） */
let createWebPlatform: typeof import('../src/platform/web').createWebPlatform

/** 内核替身的能力位旋钮（对应 `KernelCapabilities` 里被 `getFeatureStatus` 读到的四项） */
type MockCaps = {
  lowLatency: boolean
  qualitySwitch: boolean
  abr: boolean
  stats: 'full' | 'basic'
  nativeFallback: boolean
}

type MockKernelOpts = {
  /** 覆写默认能力位（默认全开、`nativeFallback: false`） */
  caps?: Partial<MockCaps>
  /** `manifest_parsed` 的载荷；传 `'never'` 表示**不派发** —— 用于「内核已建但清单未解析」 */
  manifest?: unknown
  /** `getLevels()` 返回的档位数量（影响 `probeServer` 判定的「是否多档」） */
  levels?: number
}

/**
 * 最小内核替身：load() 即视为 manifest 就绪，用于驱动 attemptPlay 分支。
 * 避免依赖真实 HLS 流；原生回退/断流等分支由 e2e 的 MockKernel 覆盖。
 *
 * @param getLive 传入即挂载 `Kernel.isLive?()`（每次读取时求值，便于用例中途翻转）。
 *   **不传 = 根本不实现该扩展方法** —— 用于覆盖「回退到 `duration` 判据」的路径
 *   （对应 `NativeKernel` 与自定义内核）。
 * @param opts 能力位 / 清单载荷 / 档位数的旋钮 —— 供端到端能力对齐用例构造各种「客户端 × 服务端」组合。
 */
function makeMockKernel(getLive?: () => boolean, opts: MockKernelOpts = {}) {
  return class MockKernel {
    // 声明而不初始化：不传 getLive 时该属性不存在于实例上（真正模拟「未实现」）
    declare isLive?: () => boolean
    static readonly kernelName = 'MockKernel'
    static isSupported(): boolean {
      return true
    }
    readonly capabilities = {
      lowLatency: true,
      qualitySwitch: true,
      abr: true,
      stats: 'full' as const,
      nativeFallback: false,
      ...(opts.caps ?? {}),
    }
    private onEvent: (e: string, d?: unknown) => void
    constructor(opts: { onEvent: (e: string, d?: unknown) => void }) {
      this.onEvent = opts.onEvent
      if (getLive) this.isLive = getLive
    }
    async load(): Promise<void> {
      if (opts.manifest === 'never') return // 内核建好但不解析清单 → 服务端侧停在 unknown
      this.onEvent('manifest_parsed', opts.manifest ?? {})
    }
    async switchURL(): Promise<void> {}
    switchQuality(): void {}
    getStats(): Record<string, unknown> {
      return {}
    }
    bufferInfo(): Record<string, unknown> {
      return { buffers: [], remaining: 0, length: 0, totalRemaining: 0, totalLength: 0, behind: 0 }
    }
    recover(): void {}
    destroy(): void {}
    getLevels(): unknown[] {
      return Array.from({ length: opts.levels ?? 0 }, (_, i) => ({
        index: i,
        width: 640 * (i + 1),
        height: 360 * (i + 1),
        bitrate: 800_000 * (i + 1),
      }))
    }
    getCurrentLevel(): number {
      return -1
    }
    setLiveLatency(): void {}
  }
}

beforeEach(async () => {
  dom = installDom()
  // 预置 <video>：installDom 的 createElement 按 tag 记忆化，Player 会拿到同一个实例
  video = dom.els['video'] ?? (dom.els['video'] = makeEl('video'))
  // DOM 就绪后再加载 Player（模块链会引入 hls.js，需先有 window/document）
  PlayerCtor ??= (await import('../src/core/Player')).Player
  createWebPlatform ??= (await import('../src/platform/web')).createWebPlatform
})

afterEach(() => {
  vi.useRealTimers()
  dom.reset()
  // locale 是全局单例（与 setLogLevel 同类语义）→ 用例结束后复位，避免污染后续用例
  setLocale(DEFAULT_LOCALE)
})

function createPlayer(
  config: Record<string, unknown> = {},
  kernelFactory: () => unknown = makeMockKernel,
): PlayerInstance {
  // P0 之后 Player 需要「平台装配包」第二参 —— 测试用真实的 Web 平台实现（跑在 DOM 替身上）
  const platform = createWebPlatform({ kernel: kernelFactory() as never })
  return new PlayerCtor(
    {
      container: '#c',
      kernel: kernelFactory() as never,
      ...config,
    } as never,
    platform as never,
  )
}

describe('原生 media error 分派（MediaError.code）', () => {
  /** 模拟原生 <video> 抛错：设置 MediaError 对象后派发 error 事件 */
  function fireMediaError(code: number | undefined, message = ''): Array<{ code: string; fatal: boolean }> {
    const p = createPlayer()
    const errs: Array<{ code: string; fatal: boolean }> = []
    p.on('error', (e) => errs.push(e as never))
    ;(video as unknown as { error: unknown }).error = code === undefined ? null : { code, message }
    video._fire('error')
    return errs
  }

  it('【回归】code=3 解码失败 → media_decode_error 且 fatal', () => {
    // 原实现一律映射成 network_error（可恢复）：解码失败会被打进「接口与 CDN 异常」，
    // 且会对不可能恢复的解码问题发起无意义重连。见 utils/errors.ts#mapMediaErrorCode。
    const errs = fireMediaError(3, 'Failed to decode')
    expect(errs[0]).toMatchObject({ code: ERROR_CODE.MEDIA_DECODE_ERROR, fatal: true })
  })

  it('code=2 网络中断 → network_error（可恢复，交内部重连）', () => {
    const errs = fireMediaError(2, 'network interrupted')
    expect(errs[0]).toMatchObject({ code: ERROR_CODE.NETWORK_ERROR, fatal: false })
  })

  it('code=4 无网络痕迹 → media_src_not_supported 且 fatal', () => {
    const errs = fireMediaError(4, 'no supported source')
    expect(errs[0]).toMatchObject({ code: ERROR_CODE.MEDIA_SRC_NOT_SUPPORTED, fatal: true })
  })

  it('code=4 带 404 痕迹 → 归 network_error（应重连而非放弃）', () => {
    const errs = fireMediaError(4, 'HTTP 404 Not Found')
    expect(errs[0]).toMatchObject({ code: ERROR_CODE.NETWORK_ERROR, fatal: false })
  })

  it('code=1 主动中止 → 不上报', () => {
    expect(fireMediaError(1, 'aborted')).toHaveLength(0)
  })

  it('无 MediaError（老浏览器/替身）→ 保持历史 network_error 行为', () => {
    const errs = fireMediaError(undefined)
    expect(errs[0]).toMatchObject({ code: ERROR_CODE.NETWORK_ERROR, fatal: false })
  })
})

describe('autoplay 语义（PlayConfig.autoplay）', () => {
  it('【回归】autoplay:false → 加载但不自动起播，意图为负', async () => {
    const p = createPlayer()
    await p.play({ url: 'https://cdn/a.m3u8', autoplay: false })
    expect(video.paused).toBe(true)
    expect(p.getState().playing).toBe(false)
  })

  it('autoplay 缺省（undefined）→ 视为播放意图，自动起播（保持既有行为）', async () => {
    const p = createPlayer()
    await p.play({ url: 'https://cdn/a.m3u8' })
    expect(video.paused).toBe(false)
    expect(p.getState().playing).toBe(true)
  })

  it('autoplay:true 与缺省等价', async () => {
    const p = createPlayer()
    await p.play({ url: 'https://cdn/a.m3u8', autoplay: true })
    expect(video.paused).toBe(false)
  })

  it('autoplay:false 之后显式 play() 仍能起播（意图转正）', async () => {
    const p = createPlayer()
    await p.play({ url: 'https://cdn/a.m3u8', autoplay: false })
    expect(video.paused).toBe(true)
    await p.play()
    expect(video.paused).toBe(false)
    expect(p.getState().playing).toBe(true)
  })
})

describe('PlayerState 进度字段', () => {
  it('初始为 currentTime=0 / duration=0', () => {
    const s = createPlayer().getState()
    expect(s.currentTime).toBe(0)
    expect(s.duration).toBe(0)
  })

  it('timeupdate 同步进度，且按整秒节流（同秒内不重复写快照）', () => {
    const p = createPlayer()
    let calls = 0
    p.subscribe(() => calls++)
    video.currentTime = 3.2
    video._fire('timeupdate')
    const after1 = calls
    expect(p.getState().currentTime).toBeCloseTo(3.2)
    video.currentTime = 3.9
    video._fire('timeupdate')
    expect(calls).toBe(after1) // 同一整秒 → 不再写
    video.currentTime = 4.1
    video._fire('timeupdate')
    expect(calls).toBe(after1 + 1)
    expect(p.getState().currentTime).toBeCloseTo(4.1)
  })

  it('直播 duration=Infinity 如实透传；NaN（元数据未就绪）归一为 0', () => {
    const p = createPlayer()
    video.duration = Infinity
    video._fire('durationchange')
    expect(p.getState().duration).toBe(Infinity)
    video.duration = NaN
    video.currentTime = 9
    video._fire('timeupdate')
    expect(p.getState().duration).toBe(0)
  })

  it('新一轮起播把进度归零', async () => {
    const p = createPlayer()
    video.currentTime = 12
    video.duration = 120
    video._fire('durationchange')
    expect(p.getState().currentTime).toBe(12)
    await p.play({ url: 'https://cdn/b.m3u8' })
    expect(p.getState().currentTime).toBe(0)
    expect(p.getState().duration).toBe(0)
  })
})

describe('posterMode: overlay', () => {
  it('overlay 模式创建封面图层并显示，起播后隐藏', async () => {
    const p = createPlayer({ posterMode: 'overlay' })
    await p.play({ url: 'https://cdn/a.m3u8', poster: 'https://img/cover.jpg' })
    const img = dom.els['img']
    expect(img).toBeTruthy()
    expect(img.src).toBe('https://img/cover.jpg')
    expect(img.style.display).toBe('block')
    video._fire('playing')
    expect(img.style.display).toBe('none')
  })

  it('native 模式不创建封面图层，改写 <video>.poster', async () => {
    const p = createPlayer()
    await p.play({ url: 'https://cdn/a.m3u8', poster: 'https://img/cover.jpg' })
    expect(dom.els['img']).toBeFalsy()
    expect(video.poster).toBe('https://img/cover.jpg')
  })

  it('destroy 清理封面图层', async () => {
    const p = createPlayer({ posterMode: 'overlay' })
    await p.play({ url: 'https://cdn/a.m3u8', poster: 'https://img/cover.jpg' })
    const img = dom.els['img']
    let removed = false
    img.remove = () => {
      removed = true
    }
    p.destroy()
    expect(removed).toBe(true)
  })
})

describe('registerPlugin 兼容实例与构造器', () => {
  class ProbePlugin {
    static readonly pluginName = 'probe'
    readonly name = 'probe'
    created = false
    inited = false
    create(): void {
      this.created = true
    }
    init(): void {
      this.inited = true
    }
    ready(): void {}
    destroy(): void {}
  }

  it('传构造器：由 SDK 实例化并注入生命周期', () => {
    const inst = createPlayer().registerPlugin(ProbePlugin as never, { x: 1 }) as unknown as ProbePlugin
    expect(inst).toBeInstanceOf(ProbePlugin)
    expect(inst.created).toBe(true)
    expect(inst.inited).toBe(true)
  })

  it('传实例：直接复用该实例，同样走 create/init', () => {
    const mine = new ProbePlugin()
    const inst = createPlayer().registerPlugin(mine as never, { x: 1 }) as unknown as ProbePlugin
    expect(inst).toBe(mine)
    expect(mine.created).toBe(true)
    expect(mine.inited).toBe(true)
  })

  it('同名插件重复注册被忽略（返回已有实例）', () => {
    const p = createPlayer()
    const a = p.registerPlugin(ProbePlugin as never)
    const b = p.registerPlugin(ProbePlugin as never)
    expect(b).toBe(a)
  })
})

describe('插件 ready 的两种时序（内核就绪前 / 后注册）', () => {
  /** 记录 `ready()` 调用时刻的替身；`throwOnReady` 用于验证异常隔离 */
  const makeProbe = (name: string, calls: string[], throwOnReady = false) => ({
    name,
    create(): void {},
    init(): void {},
    ready(): void {
      calls.push(name)
      if (throwOnReady) throw new Error('ready boom')
    },
    destroy(): void {},
  })

  it('就绪**前**注册 → 首帧时由 `readyAll()` 广播', async () => {
    const p = createPlayer()
    const calls: string[] = []
    p.registerPlugin(makeProbe('early', calls) as never)
    expect(calls).toEqual([]) // 内核尚未创建 → 不该提前调

    await p.play({ url: 'https://cdn/a.m3u8' })
    video._fire('loadeddata') // 首帧 → kernelReady = true + plugins.readyAll()
    expect(calls).toEqual(['early'])
    p.destroy()
  })

  it('就绪**后**注册 → `readyOne()` 立即补调（否则运行期动态注册的插件永远等不到）', async () => {
    const p = createPlayer()
    const calls: string[] = []
    await p.play({ url: 'https://cdn/a.m3u8' })
    video._fire('loadeddata')
    expect(calls).toEqual([])

    p.registerPlugin(makeProbe('late', calls) as never)
    expect(calls).toEqual(['late'])
    p.destroy()
  })

  it('`ready()` 抛异常只记日志、不影响后续插件（补调路径与广播路径共用同一入口）', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const p = createPlayer()
    const calls: string[] = []
    await p.play({ url: 'https://cdn/a.m3u8' })
    video._fire('loadeddata')

    p.registerPlugin(makeProbe('boom', calls, true) as never) // 抛
    expect(calls).toEqual(['boom'])
    p.registerPlugin(makeProbe('after', calls) as never) // 仍应正常补调
    expect(calls).toEqual(['boom', 'after'])
    // 异常被记录（编号可锚定），不是静默吞掉。
    // 注意 logger 会先传 '[live-sdk]' 前缀，故要在**全部**参数里找编号。
    expect(errSpy.mock.calls.some((args) => args.some((a) => String(a).includes('[LV-5004]')))).toBe(true)

    errSpy.mockRestore()
    p.destroy()
  })
})

describe('setAppState 业务扩展位', () => {
  it('写入 app.* 并触发订阅回调', () => {
    const p = createPlayer()
    let snap: PlayerInstance['getState'] extends () => infer S ? S : never
    p.subscribe((s) => (snap = s))
    p.setAppState({ 'app.roomId': '123', 'app.count': 2 })
    expect(p.getState()['app.roomId']).toBe('123')
    expect((snap! as Record<string, unknown>)['app.count']).toBe(2)
  })

  it('【回归】非 app.* 的键被忽略，不能覆盖内核字段', () => {
    const p = createPlayer()
    p.setAppState({ playing: true, muted: true } as never)
    expect(p.getState().playing).toBe(false)
    expect(p.getState().muted).toBe(false)
  })

  it('空 patch 不触发订阅', () => {
    const p = createPlayer()
    let calls = 0
    p.subscribe(() => calls++)
    p.setAppState({})
    expect(calls).toBe(0)
  })
})

describe('requestFullscreen(target?)（TODO-9）', () => {
  it('缺省 → 全屏 <video>（保持既有行为）', () => {
    const p = createPlayer()
    let videoCalls = 0
    video.requestFullscreen = () => {
      videoCalls++
      return Promise.resolve()
    }
    p.requestFullscreen()
    expect(videoCalls).toBe(1)
  })

  it('传目标元素 → 全屏该元素，且不误触 <video>', () => {
    const p = createPlayer()
    const root = p.root as HTMLElement & { requestFullscreen?: () => Promise<void> }
    let rootCalls = 0
    let videoCalls = 0
    root.requestFullscreen = () => {
      rootCalls++
      return Promise.resolve()
    }
    video.requestFullscreen = () => {
      videoCalls++
      return Promise.resolve()
    }
    p.requestFullscreen(p.root)
    expect(rootCalls).toBe(1)
    expect(videoCalls).toBe(0)
  })

  it('【回归】容器全屏时 fullscreen 快照同步为 true（早先只认 <video> 全屏）', () => {
    const p = createPlayer()
    const root = p.root as HTMLElement
    // 容器「包含」video —— 模拟文档全屏元素为 video 的祖先
    ;(root as unknown as { contains: (n: unknown) => boolean }).contains = (n) => n === video
    expect(p.getState().fullscreen).toBe(false)
    dom.doc.fullscreenElement = root
    dom.doc._fire('fullscreenchange')
    expect(p.getState().fullscreen).toBe(true)
    // 退出容器全屏 → 回到 false
    dom.doc.fullscreenElement = null
    dom.doc._fire('fullscreenchange')
    expect(p.getState().fullscreen).toBe(false)
  })

  it('<video> 自身全屏同样同步为 true', () => {
    const p = createPlayer()
    dom.doc.fullscreenElement = video as unknown as Element
    dom.doc._fire('fullscreenchange')
    expect(p.getState().fullscreen).toBe(true)
  })

  it('iOS 原生视频全屏（webkitDisplayingFullscreen）同步为 true', () => {
    const p = createPlayer()
    ;(video as unknown as { webkitDisplayingFullscreen?: boolean }).webkitDisplayingFullscreen = true
    dom.doc.fullscreenElement = null
    // iOS 原生视频全屏不派发 fullscreenchange，走 <video> 私有事件
    video._fire('webkitbeginfullscreen')
    expect(p.getState().fullscreen).toBe(true)
  })
})

describe('PlayerState 新增低频语义字段（sessionState / usingBackup）', () => {
  it('sessionState 跟随状态机；stalled 时 playing 仍为 true（二者刻意分叉）', async () => {
    const p = createPlayer()
    expect(p.getState().sessionState).toBe('idle')

    await p.play({ url: 'https://cdn/a.m3u8' }) // load → manifestParsed
    expect(p.getState().sessionState).toBe('ready')

    video._fire('playing')
    expect(p.getState().sessionState).toBe('playing')

    video._fire('waiting') // 缓冲中：会话真相是 stalled，但呈现语义仍是「播放中」
    expect(p.getState().sessionState).toBe('stalled')
    expect(p.getState().playing).toBe(true)

    video._fire('playing') // 恢复
    expect(p.getState().sessionState).toBe('playing')
    p.destroy()
  })

  it('【回归】stalled 期间用户暂停 → sessionState 必须离开 stalled（缺这条边会漏算卡顿时长）', async () => {
    const p = createPlayer()
    await p.play({ url: 'https://cdn/a.m3u8' })
    video._fire('loadeddata') // 让 firstFrameEmitted 生效，pause 才不会被初始化期噪声抑制
    video._fire('playing')
    video._fire('waiting')
    expect(p.getState().sessionState).toBe('stalled')

    video._fire('pause')
    expect(p.getState().sessionState).toBe('paused')
    expect(p.getState().playing).toBe(false)
    p.destroy()
  })

  it('usingBackup：起播复位；第 1 次重连切备用流置 true；switchURL 换源后复位', async () => {
    vi.useFakeTimers()
    try {
      const p = createPlayer({ network: { retryCount: 3, retryDelay: 1, loadTimeout: 50 } })
      await p.play({ url: 'https://cdn/primary.m3u8', backup: 'https://cdn/backup.m3u8' })
      expect(p.getState().usingBackup).toBe(false)

      video._fire('playing')
      // 原生 media error code=2（网络中断）→ 可恢复 → recover 排一次重连
      ;(video as unknown as { error: unknown }).error = { code: 2, message: 'network interrupted' }
      video._fire('error')
      await vi.advanceTimersByTimeAsync(10) // 退避 1ms + 余量 → reload
      expect(p.getState().usingBackup).toBe(true)

      await p.switchURL('https://cdn/third.m3u8')
      expect(p.getState().usingBackup).toBe(false)
      p.destroy()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('会话级累计指标（getSessionReport）', () => {
  it('未起播时为初始值（首帧耗时与起播时刻为 null，其余为 0）', () => {
    const r = createPlayer().getSessionReport()
    expect(r).toEqual({ firstFrameCost: null, stallCount: 0, stallDuration: 0, watchTime: 0, loadStartTime: null })
  })

  it('首帧信号后记录首帧耗时；新一轮起播清空且可重新记录（不依赖一次性闸门）', async () => {
    const p = createPlayer()
    await p.play({ url: 'https://cdn/a.m3u8' })
    expect(p.getSessionReport().firstFrameCost).toBeNull()
    expect(p.getSessionReport().loadStartTime).not.toBeNull()

    video._fire('loadeddata')
    expect(p.getSessionReport().firstFrameCost).not.toBeNull()

    // 新一轮起播：清空 —— 这正是旧实现做不到的（首帧闸门已关，二次起播永远测不到）
    await p.play({ url: 'https://cdn/b.m3u8' })
    expect(p.getSessionReport().firstFrameCost).toBeNull()
    video._fire('canplay')
    expect(p.getSessionReport().firstFrameCost).not.toBeNull()
    p.destroy()
  })

  it('watchTime 只累计 playing 态；stallDuration 按 STALLED→恢复 配对收口', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      const p = createPlayer()
      await p.play({ url: 'https://cdn/a.m3u8' })
      video._fire('playing')

      await vi.advanceTimersByTimeAsync(3000)
      expect(p.getSessionReport().watchTime).toBe(3000)

      video._fire('waiting') // 进入卡顿
      expect(p.getState().sessionState).toBe('stalled')
      expect(p.getSessionReport().stallCount).toBe(1)
      expect(p.getSessionReport().watchTime).toBe(3000) // 卡顿期间不再计入观看时长

      await vi.advanceTimersByTimeAsync(2000)
      expect(p.getSessionReport().stallDuration).toBe(2000) // 进行中的卡顿实时计入
      expect(p.getSessionReport().watchTime).toBe(3000)

      video._fire('playing') // 恢复
      await vi.advanceTimersByTimeAsync(1000)
      expect(p.getSessionReport().stallDuration).toBe(2000) // 已结算，不再增长
      expect(p.getSessionReport().watchTime).toBe(4000)
      p.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('卡顿不经「恢复」结束（用户暂停）也会结算，时长不漏计', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)
    try {
      const p = createPlayer()
      await p.play({ url: 'https://cdn/a.m3u8' })
      video._fire('loadeddata')
      video._fire('playing')
      await vi.advanceTimersByTimeAsync(1000)

      video._fire('waiting')
      await vi.advanceTimersByTimeAsync(500)
      video._fire('pause') // 卡顿中以「暂停」收场（不经 RECOVERED）
      expect(p.getState().sessionState).toBe('paused')
      expect(p.getSessionReport().stallDuration).toBe(500)

      await vi.advanceTimersByTimeAsync(1000)
      expect(p.getSessionReport().stallDuration).toBe(500) // 不再增长
      expect(p.getSessionReport().watchTime).toBe(1000)
      expect(p.getSessionReport().stallCount).toBe(1)
      p.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('新一轮起播重置全部累计值（一次会话一份统计）', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(3_000_000)
    try {
      const p = createPlayer()
      await p.play({ url: 'https://cdn/a.m3u8' })
      video._fire('loadeddata')
      video._fire('playing')
      await vi.advanceTimersByTimeAsync(2000)
      video._fire('waiting')
      await vi.advanceTimersByTimeAsync(1000)
      expect(p.getSessionReport().stallCount).toBe(1)

      await p.play({ url: 'https://cdn/b.m3u8' })
      const fresh = p.getSessionReport()
      expect(fresh.stallCount).toBe(0)
      expect(fresh.stallDuration).toBe(0)
      expect(fresh.watchTime).toBe(0)
      expect(fresh.firstFrameCost).toBeNull()
      p.destroy()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('重连路径的异步失败处理', () => {
  /** 首播成功、重连时 load 抛错的内核替身 */
  function makeReloadFailKernel() {
    return class ReloadFailKernel {
      static readonly kernelName = 'ReloadFailKernel'
      static isSupported(): boolean {
        return true
      }
      readonly capabilities = {
        lowLatency: false,
        qualitySwitch: false,
        abr: false,
        stats: 'basic' as const,
        nativeFallback: true,
      }
      private onEvent: (e: string, d?: unknown) => void
      private loads = 0
      constructor(opts: { onEvent: (e: string, d?: unknown) => void }) {
        this.onEvent = opts.onEvent
      }
      async load(): Promise<void> {
        this.loads++
        if (this.loads === 1) {
          this.onEvent('manifest_parsed', {})
          return
        }
        throw new Error('reload failed')
      }
      async switchURL(): Promise<void> {}
      switchQuality(): void {}
      getStats(): Record<string, unknown> {
        return {}
      }
      bufferInfo(): Record<string, unknown> {
        return { buffers: [], behind: 0, remaining: 0, length: 0, totalRemaining: 0, totalLength: 0 }
      }
      recover(): void {}
      destroy(): void {}
      getLevels(): unknown[] {
        return []
      }
      getCurrentLevel(): number {
        return -1
      }
    }
  }

  it('【回归】重连时内核 load 失败：Promise 被消费并进入错误通道（不产生 unhandledrejection）', async () => {
    vi.useFakeTimers()
    try {
      const p = createPlayer({
        kernel: makeReloadFailKernel() as never,
        network: { retryCount: 2, retryDelay: 1, loadTimeout: 50 },
      })
      const codes: string[] = []
      p.on('error', (e) => codes.push((e as { code: string }).code))

      await p.play({ url: 'https://cdn/primary.m3u8' })
      video._fire('playing')
      // 可恢复的原生 media error → recover 排一次重连 → 重连的 load reject
      ;(video as unknown as { error: unknown }).error = { code: 2, message: 'network interrupted' }
      video._fire('error')
      await vi.advanceTimersByTimeAsync(20)
      await vi.advanceTimersByTimeAsync(0) // 冲掉 reject 的 catch 回调

      // 若 reload 未消费该 Promise，这里不会有 manifest_load_error：
      // 异常变成 unhandledrejection（Node 下崩进程、浏览器里落到全局错误监控），
      // 而不是回到 SDK 的错误分级链路。
      expect(codes).toContain(ERROR_CODE.MANIFEST_LOAD_ERROR)
      p.destroy()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('COMMAND 事件（统一命令观测）', () => {
  type Seen = { name: string; phase: string; applied?: boolean }

  /** 依次调用全部 12 个命令，收集 COMMAND 事件 */
  async function runAllTwelve(p: PlayerInstance): Promise<Seen[]> {
    const seen: Seen[] = []
    p.on('command', (e) => seen.push(e as Seen))
    await p.play({ url: 'https://cdn/a.m3u8' })
    p.pause()
    p.mute(true)
    p.setVolume(0.5)
    await p.switchQuality(1)
    await p.switchURL('https://cdn/b.m3u8')
    p.requestFullscreen()
    p.exitFullscreen()
    p.seek(10)
    p.setPlaybackRate(1.5)
    p.setPoster('https://img/c.jpg')
    p.setLiveLatency(3, 8)
    return seen
  }

  it('12 个命令全覆盖，且每个命令 before/after 严格成对', async () => {
    const p = createPlayer()
    const seen = await runAllTwelve(p)

    const names = new Set(seen.map((e) => e.name))
    expect(names.size).toBe(COMMAND_NAMES.length) // 12
    for (const n of COMMAND_NAMES) expect(names.has(n), `命令 ${n} 未派发 COMMAND`).toBe(true)

    for (const n of COMMAND_NAMES) {
      const evts = seen.filter((e) => e.name === n)
      expect(
        evts.map((e) => e.phase),
        `命令 ${n} 的 before/after 不成对`,
      ).toEqual(['before', 'after'])
    }
    p.destroy()
  })

  it('applied 只在 after 阶段出现（before 时结果未知）', async () => {
    const p = createPlayer()
    const seen = await runAllTwelve(p)
    for (const e of seen) {
      if (e.phase === 'before') expect(e.applied).toBeUndefined()
      else expect(typeof e.applied, `命令 ${e.name} 的 after 缺 applied`).toBe('boolean')
    }
    p.destroy()
  })

  it('applied 反映真实语义：seek 在直播下 false、点播下 true（**内核未实现 isLive 的回退路径**）', async () => {
    const p = createPlayer() // 默认替身不实现 isLive → 判据回退到 `duration`（= NativeKernel 路径）
    const seen: Seen[] = []
    p.on('command', (e) => seen.push(e as Seen))

    // 直播（原生 HLS：duration 为 Infinity）→ noop
    video.duration = Infinity
    video._fire('durationchange')
    p.seek(30)
    expect(seen.at(-1)).toMatchObject({ name: 'seek', phase: 'after', applied: false })

    // 点播 / 重播（有限时长）→ 生效
    video.duration = 120
    video.currentTime = 0
    p.seek(30)
    expect(seen.at(-1)).toMatchObject({ name: 'seek', phase: 'after', applied: true })
    expect(video.currentTime).toBe(30)
    p.destroy()
  })

  it('【回归】直播判据来自内核：duration 有限（MSE 路径）也照旧 noop，翻转后自动可用', async () => {
    let live = true
    const LiveKernel = makeMockKernel(() => live) // 替身挂上 isLive，值可中途翻转
    const p = createPlayer({}, () => LiveKernel)
    await p.play({ url: 'https://cdn/live.m3u8' }) // 起播 → 内核实例就绪，判据才会问内核
    const seen: Seen[] = []
    p.on('command', (e) => seen.push(e as Seen))

    // 模拟 MSE 路径下的直播：hls.js 默认 `liveDurationInfinity: false`，
    // 会把 MediaSource.duration 写成 playlist edge —— **有限值**、随滑窗递增。
    // 旧判据（`!Number.isFinite(duration)`）在这里漏判 → seek 会真的落到媒体面。
    video.duration = 3600
    video._fire('durationchange')

    p.seek(30)
    expect(seen.at(-1)).toMatchObject({ name: 'seek', phase: 'after', applied: false })
    expect(video.currentTime).toBe(0) // 未落到媒体面

    // 直播结束（playlist 出现 #EXT-X-ENDLIST）→ 内核翻转 → 时间轴转为可定位
    live = false
    p.seek(30)
    expect(seen.at(-1)).toMatchObject({ name: 'seek', phase: 'after', applied: true })
    expect(video.currentTime).toBe(30)
    p.destroy()
  })

  it('【回归】低延迟直播贴到 playlist edge 卡顿 → 不得误判 ended（旧判据会误报「直播已结束」）', async () => {
    const p = createPlayer({}, () => makeMockKernel(() => true))
    await p.play({ url: 'https://cdn/live.m3u8' })
    video._fire('playing')

    const ended: unknown[] = []
    p.on('ended', (e) => ended.push(e))

    // duration = playlist edge（有限）；已缓冲到 edge、播放点也贴着 edge
    // —— LL-HLS 目标延迟低于 1s 容差时即可达：旧判据判「近尾」→ `onStall()` 直接 transition('ended')
    video.duration = 3600
    video.currentTime = 3600
    video.buffered = makeTimeRanges([[3500, 3600]])
    video._fire('durationchange')
    video._fire('waiting')

    expect(ended).toHaveLength(0)
    expect(p.getState().sessionState).toBe('stalled') // 按卡顿处理（会走重连），而非 ended
    p.destroy()
  })

  it('【回归】直播中原生 ended 不等于「直播结束」→ 不派发 ENDED，改走断流恢复', async () => {
    vi.useFakeTimers()
    const p = createPlayer(
      { network: { retryCount: 3, retryDelay: 1, loadTimeout: 50 } },
      () => makeMockKernel(() => true),
    )
    await p.play({ url: 'https://cdn/live.m3u8' })
    video._fire('playing')

    const ended: unknown[] = []
    const retried: unknown[] = []
    p.on('ended', (e) => ended.push(e))
    p.on('retry', (e) => retried.push(e))

    // MSE 直播：duration = playlist edge（有限）。流停止更新 → 播放点追到该值 → 原生 ended
    // （且此后不会自行恢复），旧实现会据此宣告「直播已结束」并停掉重连。
    video.duration = 3600
    video.currentTime = 3600
    video._fire('durationchange')
    video._fire('ended')

    expect(ended).toHaveLength(0) // 不宣告「直播已结束」
    expect(retried).toHaveLength(1) // 而是进入断流恢复
    expect(p.getState().playing).toBe(true) // 按钮保持「播放中」
    p.destroy()
  })

  it('内核翻转为非直播后，原生 ended 才是真的结束', async () => {
    let live = true
    const LiveKernel = makeMockKernel(() => live)
    const p = createPlayer({}, () => LiveKernel)
    await p.play({ url: 'https://cdn/live.m3u8' })
    video._fire('playing')

    video.duration = 3600
    video.currentTime = 3600
    video._fire('durationchange')

    live = false // playlist 出现了 #EXT-X-ENDLIST → 内核翻转
    const ended: unknown[] = []
    p.on('ended', (e) => ended.push(e))
    video._fire('ended')

    expect(ended).toHaveLength(1)
    expect(p.getState().sessionState).toBe('ended')
    expect(p.getState().playing).toBe(false)
    p.destroy()
  })

  it('非直播（内核未实现 isLive 的回退路径）中原生 ended 照常宣告结束', async () => {
    const p = createPlayer()
    await p.play({ url: 'https://cdn/vod.m3u8' })
    video._fire('playing')

    const ended: unknown[] = []
    p.on('ended', (e) => ended.push(e))

    video.duration = 120
    video.currentTime = 120
    video._fire('durationchange')
    video._fire('ended')

    expect(ended).toHaveLength(1)
    expect(p.getState().sessionState).toBe('ended')
    p.destroy()
  })



  it('applied：switchQuality 传入档位表里没有的 id → false', async () => {
    const p = createPlayer()
    const seen: Seen[] = []
    p.on('command', (e) => seen.push(e as Seen))
    await p.switchQuality(999) // qualityMap 无此 id
    expect(seen.at(-1)).toMatchObject({ name: 'switchQuality', phase: 'after', applied: false })
    p.destroy()
  })

  it('【关键】被钩子拦截的命令仍派发 after，且 applied=false（而非静默不派发）', async () => {
    const p = createPlayer()
    const seen: Seen[] = []
    p.on('command', (e) => seen.push(e as Seen))
    p.useHooks('play', (ctx) => {
      const c = ctx as { phase: string; cancelled: boolean }
      if (c.phase === 'before') c.cancelled = true
    })
    await p.play({ url: 'https://cdn/a.m3u8' })
    const playEvents = seen.filter((e) => e.name === 'play')
    expect(playEvents.map((e) => e.phase)).toEqual(['before', 'after'])
    expect(playEvents[1].applied).toBe(false)
    p.destroy()
  })

  it('error 事件带 domain（错误域收敛层，接入方不必自建映射表）', async () => {
    const p = createPlayer()
    const got: Array<{ code: string; domain: string }> = []
    p.on('error', (e) => got.push(e as { code: string; domain: string }))
    // 原生 media error code=3（解码失败）→ media_decode_error / decode
    ;(video as unknown as { error: unknown }).error = { code: 3, message: 'decode failed' }
    video._fire('error')
    expect(got.at(-1)).toMatchObject({ code: ERROR_CODE.MEDIA_DECODE_ERROR, domain: ERROR_DOMAIN.DECODE })
    p.destroy()
  })
})

describe('容器零尺寸告警', () => {
  function captureWarns(): { warns: string[]; restore: () => void } {
    const warns: string[] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => warns.push(a.map(String).join(' '))
    return { warns, restore: () => (console.warn = orig) }
  }
  /** 让 root 报告指定尺寸（fixture 默认没有测量能力，见下一条用例） */
  function stubSize(p: PlayerInstance, width: number, height: number): void {
    ;(p.root as unknown as { getBoundingClientRect: () => { width: number; height: number } }).getBoundingClientRect =
      () => ({ width, height })
  }
  // 锚定**消息编号**（与语言无关），而不是文案本身 —— 文案随 locale 变，编号不变
  const hit = (warns: string[]) => warns.filter((w) => w.includes('[LV-4005]')).length

  it('零尺寸 → 起播时告警一次，重复起播不重复告警', async () => {
    const p = createPlayer()
    stubSize(p, 0, 0)
    const cap = captureWarns()
    try {
      await p.play({ url: 'https://cdn/a.m3u8' })
      await p.play({ url: 'https://cdn/b.m3u8' })
    } finally {
      cap.restore()
    }
    expect(hit(cap.warns)).toBe(1)
    p.destroy()
  })

  it('仅有宽度、高度为 0（父级无高度的经典场景）→ 告警', async () => {
    const p = createPlayer()
    stubSize(p, 640, 0)
    const cap = captureWarns()
    try {
      await p.play({ url: 'https://cdn/a.m3u8' })
    } finally {
      cap.restore()
    }
    expect(hit(cap.warns)).toBe(1)
    p.destroy()
  })

  it('尺寸正常 → 不告警', async () => {
    const p = createPlayer()
    stubSize(p, 640, 360)
    const cap = captureWarns()
    try {
      await p.play({ url: 'https://cdn/a.m3u8' })
    } finally {
      cap.restore()
    }
    expect(hit(cap.warns)).toBe(0)
    p.destroy()
  })

  it('【关键】环境测不到尺寸（DOM 替身 / 非浏览器）→ 不告警，不把「测不到」当 0', async () => {
    const p = createPlayer() // fixture 的 root 无 getBoundingClientRect / offsetWidth
    const cap = captureWarns()
    try {
      await p.play({ url: 'https://cdn/a.m3u8' })
    } finally {
      cap.restore()
    }
    expect(hit(cap.warns)).toBe(0)
    p.destroy()
  })
})

describe('运行期消息语言（PlayerConfig.locale，默认 en）', () => {
  /** 取一条 SDK 自产消息：`play({})` 缺 url → throw（[LV-4002]） */
  async function playWithoutUrl(p: PlayerInstance): Promise<string> {
    try {
      await p.play({} as never)
    } catch (e) {
      return (e as Error).message
    }
    return ''
  }

  it('默认英文；显式 locale: "zh" 时同一条编号给中文', async () => {
    const pEn = createPlayer()
    expect(getLocale()).toBe('en')
    expect(await playWithoutUrl(pEn)).toBe('[LV-4002] PlayConfig.url is missing')
    pEn.destroy()

    const pZh = createPlayer({ locale: 'zh' })
    expect(getLocale()).toBe('zh')
    expect(await playWithoutUrl(pZh)).toBe('[LV-4002] PlayConfig.url 缺失')
    pZh.destroy()
  })

  it('消息自带 [LV-xxxx] 编号前缀 —— 与语言无关，接入方可直接锚定编号做告警', async () => {
    const p = createPlayer()
    const msg = await playWithoutUrl(p)
    expect(msg.startsWith('[LV-4002] ')).toBe(true)
    // 编号恒定，只有后半段随语言变化（上一用例已覆盖中文）
    p.destroy()
  })
})


// ═══════════════════════════════════════════════════════════════════════════════
// 以下两组用例原先各自独立成文件（`test/features.test.ts` / `test/retry.test.ts`），
// 对应 `src/utils/features.ts` 与 `src/utils/retry.ts`。两个模块的唯一生产消费者都是
// `Player`，已并入 `core/Player.ts`（私有方法 / 文件内局部），故用例随之迁到本文件 ——
// 入口从「直接调用纯函数」换成「驱动 Player 的公开行为」。
// ═══════════════════════════════════════════════════════════════════════════════

describe('端到端能力对齐（getFeatureStatus；规则原 utils/features.ts）', () => {
  type Report = ReturnType<PlayerInstance['getFeatureStatus']>
  const pick = (r: Report, f: string) => r.features.find((x) => x.feature === f)!

  /**
   * 按给定条件起播一次并取对齐报告。
   *
   * `getFeatureStatus()` 是 `matchFeature` **唯一的可达入口**（它已私有化），
   * 所以每种「客户端 × 服务端」组合都要靠内核能力位 + 清单载荷 + 档位数来构造。
   */
  async function featureReport(opts: MockKernelOpts & { observability?: 'full' | 'basic' } = {}): Promise<Report> {
    const p = createPlayer(
      { observability: opts.observability ?? 'full' },
      () => makeMockKernel(undefined, opts),
    )
    await p.play({ url: 'https://cdn/a.m3u8' })
    const report = p.getFeatureStatus()
    p.destroy()
    return report
  }

  it('两端都 supported → matched 且无 detail（abr / qualitySwitch）', async () => {
    const r = await featureReport({ levels: 2 })
    expect(pick(r, 'abr')).toMatchObject({ client: 'supported', server: 'supported', matched: true })
    expect(pick(r, 'abr').detail).toBeUndefined()
    expect(pick(r, 'qualitySwitch').matched).toBe(true)
  })

  it('client=absent（drm 恒 absent）→ 未对齐，detail 指「客户端不支持」', async () => {
    const r = await featureReport({ levels: 2 })
    expect(pick(r, 'drm')).toMatchObject({
      client: 'absent',
      matched: false,
      detail: '[LV-6002] unsupported by the client',
    })
  })

  it('server=absent（清单未声明 LL）→ 未对齐，detail 指「服务端未提供」', async () => {
    const r = await featureReport({ manifest: {} }) // 载荷无 hasLL → 服务端 lowLatency=absent
    expect(pick(r, 'lowLatency')).toMatchObject({
      client: 'supported',
      server: 'absent',
      matched: false,
      detail: '[LV-6003] not provided by the server',
    })
  })

  it('清单声明 hasLL → lowLatency 两端对齐', async () => {
    const r = await featureReport({ manifest: { hasLL: true } })
    expect(pick(r, 'lowLatency')).toMatchObject({ client: 'supported', server: 'supported', matched: true })
  })

  it('【回归】server=unknown 不得判 matched（旧 bug：airplay 特例绕过服务端判据）', async () => {
    // 内核已建（capabilities 可读）但清单尚未解析 → 服务端侧全部停在 unknown
    const r = await featureReport({ manifest: 'never' })
    expect(pick(r, 'abr')).toMatchObject({ client: 'supported', server: 'unknown', matched: false })
    expect(pick(r, 'abr').detail).toBe('[LV-6003] not provided by the server')
  })

  it('observability=basic → 客户端侧 lowLatency 降为 absent（观测不深就不claim 低延迟）', async () => {
    const r = await featureReport({ observability: 'basic', manifest: { hasLL: true } })
    expect(pick(r, 'lowLatency')).toMatchObject({
      client: 'absent',
      server: 'supported',
      matched: false,
      detail: '[LV-6002] unsupported by the client',
    })
  })

  it('airplay MSE 路径：client=supported + server=supported → matched 且无 detail', async () => {
    const r = await featureReport()
    expect(pick(r, 'airplay')).toMatchObject({ client: 'supported', matched: true })
    expect(pick(r, 'airplay').detail).toBeUndefined()
  })

  it('airplay 原生回退：client=degraded + server=supported → matched，detail 说明由系统接管', async () => {
    const r = await featureReport({ caps: { nativeFallback: true } })
    expect(pick(r, 'airplay')).toMatchObject({
      client: 'degraded',
      server: 'supported',
      matched: true,
      detail: '[LV-6005] native fallback path; casting is handled by the system',
    })
  })

  it('报告恒 5 项，summary 计数与项数一致', async () => {
    const r = await featureReport({ levels: 2, manifest: { hasLL: true } })
    expect(r.features.map((f) => f.feature).sort()).toEqual(['abr', 'airplay', 'drm', 'lowLatency', 'qualitySwitch'])
    const matched = r.features.filter((f) => f.matched).length
    expect(r.summary).toEqual({ matched, mismatched: 5 - matched })
  })

  // ⚠️ 迁移**丢掉**的三格（生产路径不可达，故不再有用例；见 docs/implementation.md §8.22）：
  //   `client='unknown'`（`getFeatureStatus` 只产出 supported/absent/degraded）、
  //   `server='degraded'`（`probeServer` 只产出 supported/absent/unknown，airplay 恒 supported）。
})

describe('断流恢复：错误去重与指数退避（原 utils/retry.ts）', () => {
  /** 可控时钟：去重窗口与「故障复发」都靠它驱动（比 fake timers 更小、更准） */
  let clock = 1_700_000_000_000
  let nowSpy: { mockRestore: () => void }

  beforeEach(() => {
    clock = 1_700_000_000_000
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock)
  })
  afterEach(() => nowSpy.mockRestore())

  /** 模拟原生 <video> 抛错（MediaError.code）→ 走 Player 的错误分级链路 */
  function fire(code: number | undefined, message = ''): void {
    ;(video as unknown as { error: unknown }).error = code === undefined ? null : { code, message }
    video._fire('error')
  }

  /** 起播一个播放器，并收集 ERROR / RETRY 两条通道（去重与退避都在这两处外化） */
  async function recoverable(opts: { retryCount?: number; retryDelay?: number } = {}) {
    const p = createPlayer({
      network: { retryCount: opts.retryCount ?? 5, retryDelay: opts.retryDelay ?? 1000, loadTimeout: 60_000 },
    })
    const errors: Array<{ code: string }> = []
    const delays: number[] = []
    p.on('error', (e) => errors.push(e as { code: string }))
    p.on('retry', (e) => delays.push((e as { delay: number }).delay))
    await p.play({ url: 'https://cdn/a.m3u8' })
    return { p, errors, delays }
  }

  /** 连续触发 n 次可恢复错误；每次之间把时钟推过 10s 去重窗口，避免被抑制 */
  function fireRecoverable(n: number, code = 2, message = 'network interrupted'): void {
    for (let i = 0; i < n; i++) {
      if (i > 0) clock += 20_000
      fire(code, message)
    }
  }

  it('首次出现的错误 → 放行（派发 ERROR 并进入重连）', async () => {
    const { p, errors, delays } = await recoverable()
    fire(2, 'network interrupted')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: ERROR_CODE.NETWORK_ERROR })
    expect(delays).toHaveLength(1) // 可恢复 → 排了一次重连
    p.destroy()
  })

  it('窗口内同类错误 → 抑制（连 Sentry 都不该被刷屏）', async () => {
    const { p, errors } = await recoverable()
    fire(2)
    clock += 1
    fire(2)
    expect(errors).toHaveLength(1)
    p.destroy()
  })

  it('窗口内同类错误连续出现 → 只放行第一条', async () => {
    const { p, errors } = await recoverable()
    fire(2)
    clock += 1
    fire(2)
    clock += 9_998 // 距首条共 9_999ms，仍在窗口内
    fire(2)
    expect(errors).toHaveLength(1)
    p.destroy()
  })

  it('恰好超出窗口边界（10_000ms）→ 放行（故障复发，需要重新上报）', async () => {
    const { p, errors } = await recoverable()
    fire(2)
    clock += 10_000
    fire(2)
    expect(errors).toHaveLength(2)
    p.destroy()
  })

  it('不同 code 互相不抑制（故障变了必须放行）', async () => {
    const { p, errors } = await recoverable()
    fire(2) // → network_error（可恢复）
    clock += 1
    fire(3) // → media_decode_error（fatal，不重连，但仍要透出）
    expect(errors.map((e) => e.code)).toEqual([ERROR_CODE.NETWORK_ERROR, ERROR_CODE.MEDIA_DECODE_ERROR])
    p.destroy()
  })

  it('换 code 后原 code 的窗口被重置（以最后一次放行为准）', async () => {
    const { p, errors } = await recoverable()
    fire(2) // A 放行
    clock += 5_000
    fire(3) // B 放行，state 变为 B
    clock += 1_000 // 距 A 仅 6s，若按 A 的窗口判就会被抑制
    fire(2) // A 再出现：与 state(B) 不同 → 放行
    expect(errors).toHaveLength(3)
    p.destroy()
  })

  it('抑制时不更新窗口起点（否则窗口无限顺延，故障永不复发上报）', async () => {
    const { p, errors } = await recoverable()
    fire(2) // t0 放行
    clock += 9_000
    fire(2) // 被抑制 —— 不得把起点刷成 t0+9s
    clock += 1_000 // 距**首条**恰好 10_000ms → 已超窗
    fire(2)
    expect(errors).toHaveLength(2)
    p.destroy()
  })

  it('退避：无抖动时 = base * 2^(n-1)', async () => {
    const { p, delays } = await recoverable({ retryCount: 8, retryDelay: 1000 })
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0)
    fireRecoverable(4)
    expect(delays).toEqual([1000, 2000, 4000, 8000])
    rand.mockRestore()
    p.destroy()
  })

  it('退避：抖动上限为 base（Math.random → 1）', async () => {
    const { p, delays } = await recoverable({ retryCount: 8, retryDelay: 1000 })
    const rand = vi.spyOn(Math, 'random').mockReturnValue(1)
    fireRecoverable(3)
    expect(delays).toEqual([2000, 3000, 5000])
    rand.mockRestore()
    p.destroy()
  })

  it('退避：严格落在 [base*2^(n-1), base*2^(n-1) + base) 区间内', async () => {
    const base = 500
    const { p, delays } = await recoverable({ retryCount: 8, retryDelay: base })
    fireRecoverable(6)
    expect(delays).toHaveLength(6)
    delays.forEach((d, i) => {
      const exp = base * Math.pow(2, i)
      expect(d, `第 ${i + 1} 次退避`).toBeGreaterThanOrEqual(exp)
      expect(d, `第 ${i + 1} 次退避`).toBeLessThan(exp + base)
    })
    p.destroy()
  })

  it('退避：同抖动比例下递增（指数增长不被抖动吃掉）', async () => {
    const { p, delays } = await recoverable({ retryCount: 8, retryDelay: 1000 })
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    fireRecoverable(3)
    expect(delays).toEqual([1500, 2500, 4500])
    expect(delays[1]).toBeGreaterThan(delays[0])
    expect(delays[2]).toBeGreaterThan(delays[1])
    rand.mockRestore()
    p.destroy()
  })

  it('退避：默认使用 Math.random（不注入也有限、可用）', async () => {
    const { p, delays } = await recoverable({ retryCount: 8, retryDelay: 1000 })
    const spy = vi.spyOn(Math, 'random')
    fireRecoverable(1)
    expect(spy).toHaveBeenCalled()
    expect(Number.isFinite(delays[0])).toBe(true)
    spy.mockRestore()
    p.destroy()
  })
})
