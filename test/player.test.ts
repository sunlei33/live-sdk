import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installDom, makeEl, makeTimeRanges, type FakeMediaElement } from './fixtures/dom'
import { ERROR_CODE, COMMAND_NAMES, ERROR_DOMAIN } from '../src/constants'

type Dom = ReturnType<typeof installDom>
type PlayerInstance = import('../src/core/Player').Player

let dom: Dom
let video: FakeMediaElement
let PlayerCtor: typeof import('../src/core/Player').Player
/** P0：`Player` 需注入平台装配包；测试用真实 Web 实现（动态导入，等 DOM 就绪） */
let createWebPlatform: typeof import('../src/platform/web').createWebPlatform

/**
 * 最小内核替身：load() 即视为 manifest 就绪，用于驱动 attemptPlay 分支。
 * 避免依赖真实 HLS 流；原生回退/断流等分支由 e2e 的 MockKernel 覆盖。
 *
 * @param getLive 传入即挂载 `Kernel.isLive?()`（每次读取时求值，便于用例中途翻转）。
 *   **不传 = 根本不实现该扩展方法** —— 用于覆盖「回退到 `duration` 判据」的路径
 *   （对应 `NativeKernel` 与自定义内核）。
 */
function makeMockKernel(getLive?: () => boolean) {
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
    }
    private onEvent: (e: string, d?: unknown) => void
    constructor(opts: { onEvent: (e: string, d?: unknown) => void }) {
      this.onEvent = opts.onEvent
      if (getLive) this.isLive = getLive
    }
    async load(): Promise<void> {
      this.onEvent('manifest_parsed', {})
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
      return []
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
  const hit = (warns: string[]) => warns.filter((w) => w.includes('容器尺寸为 0')).length

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
