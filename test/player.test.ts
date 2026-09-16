import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installDom, makeEl, type FakeMediaElement } from './fixtures/dom'
import { ERROR_CODE } from '../src/constants'

type Dom = ReturnType<typeof installDom>
type PlayerInstance = import('../src/core/Player').Player

let dom: Dom
let video: FakeMediaElement
let PlayerCtor: typeof import('../src/core/Player').Player

/**
 * 最小内核替身：load() 即视为 manifest 就绪，用于驱动 attemptPlay 分支。
 * 避免依赖真实 HLS 流；原生回退/断流等分支由 e2e 的 MockKernel 覆盖。
 */
function makeMockKernel() {
  return class MockKernel {
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
})

afterEach(() => {
  vi.useRealTimers()
  dom.reset()
})

function createPlayer(config: Record<string, unknown> = {}): PlayerInstance {
  return new PlayerCtor({
    container: '#c',
    kernel: makeMockKernel() as never,
    ...config,
  } as never)
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
