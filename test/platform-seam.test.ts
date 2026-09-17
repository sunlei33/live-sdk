/**
 * 平台接缝测试：**用「非 DOM 的假媒体面 + 假承载面」构造 Player，并跑通起播 / 命令 / 事件 / 销毁链路**。
 *
 * ── 这个文件存在的意义 ──
 *
 * 它是「架构适配性是否足够」的**直接证据**，而不是论证：
 * 如果 core 真的只依赖 `MediaSurface` / `HostMount` / `EnvAdapter` 契约，
 * 那么在没有 `document` / `window` 的环境里，换一套完全不同的实现也应该照常工作。
 *
 * 三个断言层次：
 * 1. **本文件在模块顶层静态 `import { Player }`**：若 core 仍 `import 'hls.js'` 之类，
 *    这一步就会因缺 DOM 而失败（比任何文档都硬）；
 * 2. 全程不安装 DOM 替身，`document` / `window` 不存在；
 * 3. 命令 → 假媒体面真的收到调用；事件 → 从假媒体面派发后 core 状态与快照随之变化。
 *
 * ── 它没证明什么 ──
 *
 * 不证明**类型层**的平台中立：`player.media` / `player.root` 仍声明 Web 类型
 * （P1 有意取舍，见 spec §3.10），因此这里用 `as` 收窄。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Player } from '../src/core/Player'
import { logger } from '../src/utils/logger'
import { Events } from '../src/constants'
import type {
  EnvAdapter,
  HostMount,
  Kernel,
  KernelCapabilities,
  KernelConstructor,
  MediaSurface,
  PlatformAdapters,
} from '../src/types'

/** 假媒体面：不涉及任何 DOM，只记录调用 */
function makeFakeSurface() {
  const calls: string[] = []
  const listeners = new Map<string, Set<() => void>>()
  const state = { paused: true, muted: false, volume: 1, rate: 1, currentTime: 0, duration: 7200 }

  const surface: MediaSurface<{ kind: string }> & { calls: string[]; fire: (t: string) => void } = {
    raw: { kind: 'fake-media' }, // ← 非 DOM：一个普通对象
    calls,
    fire(type: string) {
      for (const cb of listeners.get(type) ?? []) cb()
    },
    play: async () => {
      calls.push('play')
      state.paused = false
    },
    pause: () => {
      calls.push('pause')
      state.paused = true
    },
    seek: (t: number) => {
      calls.push(`seek:${t}`)
      state.currentTime = t
    },
    muted: false,
    volume: 1,
    playbackRate: 1,
    get paused() {
      return state.paused
    },
    get currentTime() {
      return state.currentTime
    },
    get duration() {
      return state.duration
    },
    requestFullscreen: () => calls.push('requestFullscreen'),
    exitFullscreen: () => calls.push('exitFullscreen'),
    isFullscreen: () => false,
    error: () => null,
    buffered: () => [[0, 30]] as Array<[number, number]>,
    /**
     * 媒体设备能力由**本平台**自行回答（这正是它进契约而非留在平台外探测的理由）：
     * 这里模拟「本宿主原生就能播 HLS」，无需 `canPlayType`。
     */
    canPlay: (type: string) => {
      calls.push(`canPlay:${type}`)
      return type === 'application/vnd.apple.mpegurl'
    },
    on: (event: string, cb: (data?: unknown) => void) => {
      calls.push(`on:${event}`)
      const set = listeners.get(event) ?? new Set()
      set.add(cb)
      listeners.set(event, set)
      return () => calls.push(`off:${event}`)
    },
    destroy: () => calls.push('destroy'),
  }
  return surface
}

/** 假承载面：同样不涉及 DOM；`measure` 可注入「测不到」与「真的是 0」两种态 */
function makeFakeHost(measure: (() => { width: number; height: number } | null) | null = null) {
  const calls: string[] = []
  const host: HostMount<{ kind: string }> & { calls: string[] } = {
    root: { kind: 'fake-root' }, // ← 非 DOM：一个普通对象
    calls,
    mount: (container, media) => calls.push(`mount:${String(container)}:${(media as { kind?: string }).kind}`),
    measure: measure ?? (() => ({ width: 640, height: 360 })),
    showPosterOverlay: (src) => calls.push(`poster:${src}`),
    hidePosterOverlay: () => calls.push('poster:hide'),
    destroy: () => calls.push('destroy'),
  }
  return host
}

const CAPS: KernelCapabilities = {
  lowLatency: false,
  qualitySwitch: false,
  abr: false,
  stats: 'basic',
  nativeFallback: false,
}

/** 极简内核：只满足契约（不是 hls.js，也不是 NativeKernel） */
function makeFakeKernel() {
  const loaded: string[] = []
  class FakeKernel implements Kernel {
    static isSupported(): boolean {
      return true
    }
    static readonly kernelName = 'FakeKernel'
    readonly capabilities = CAPS
    constructor(private opts: { onEvent: (e: string, d?: unknown) => void }) {}
    async load(url: string): Promise<void> {
      loaded.push(url)
      this.opts.onEvent('manifest_parsed', { url })
    }
    async switchURL(url: string): Promise<void> {
      loaded.push(url)
    }
    switchQuality(): void {}
    getStats(): Record<string, unknown> {
      return {}
    }
    bufferInfo(): Record<string, unknown> {
      return { buffers: [], behind: 0, remaining: 0, length: 0, totalRemaining: 0, totalLength: 0 }
    }
    recover(): void {}
    destroy(): void {}
  }
  return { Ctor: FakeKernel as unknown as KernelConstructor, loaded }
}

const fakeEnv: EnvAdapter = {
  getVisibility: () => 'foreground',
  onVisibilityChange: () => () => undefined,
  isOnline: () => true,
  onNetworkChange: () => () => undefined,
}

function makePlatform(surface: ReturnType<typeof makeFakeSurface>, host: ReturnType<typeof makeFakeHost>, kernel: KernelConstructor): PlatformAdapters {
  return {
    media: surface as never,
    host: host as never,
    env: fakeEnv,
    selectKernel: () => kernel,
    presets: {}, // 空预设：本测试只关心平台接缝，不引入插件
    zeroSizeHint: '（假平台提示：请给容器高度）',
  }
}

let host: ReturnType<typeof makeFakeHost>
let surface: ReturnType<typeof makeFakeSurface>
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  surface = makeFakeSurface()
  host = makeFakeHost()
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
})

describe('平台接缝：非 DOM 宿主也能跑通（架构适配性的直接证据）', () => {
  it('本测试环境确实没有 DOM（否则下面的结论不成立）', () => {
    expect(typeof document).toBe('undefined')
    expect(typeof window).toBe('undefined')
  })

  it('用假媒体面 + 假承载面构造 Player，不触碰任何 DOM', () => {
    const { Ctor } = makeFakeKernel()
    const p = new Player({ container: '#mini', kernel: Ctor } as never, makePlatform(surface, host, Ctor) as never)

    // 挂载走了承载面契约（容器原样透传：core 不解释 container 是什么）
    expect(host.calls).toContain('mount:#mini:fake-media')
    // 对外暴露的 media / root 来自平台注入（非 Web 宿主就是它自己的对象）
    expect((p.media as unknown as { kind: string }).kind).toBe('fake-media')
    expect((p.root as unknown as { kind: string }).kind).toBe('fake-root')
    // 事件订阅全部经契约（core 不写 el.addEventListener）；全屏由平台侧合一为一个事件名
    expect(surface.calls).toContain('on:play')
    expect(surface.calls).toContain('on:playing')
    expect(surface.calls).toContain('on:error')
    expect(surface.calls).toContain('on:fullscreenchange')

    p.destroy()
  })

  it('起播链路：命令进内核、事件回 core、状态快照更新', async () => {
    const { Ctor, loaded } = makeFakeKernel()
    const p = new Player(
      { container: '#mini', url: 'https://cdn/live.m3u8', kernel: Ctor } as never,
      makePlatform(surface, host, Ctor) as never,
    )

    const events: string[] = []
    p.on(Events.MANIFEST_PARSED, () => events.push('manifest_parsed'))

    await p.play()
    expect(loaded).toEqual(['https://cdn/live.m3u8']) // 内核真的被要求加载
    expect(events).toContain('manifest_parsed') // 内核事件 → core 事件

    // 媒体面派发「playing」→ core 侧会话态与快照应随之变化（事件链路是双向的）
    surface.fire('playing')
    expect(p.getState().sessionState).toBe('playing')
    expect(p.getState().playing).toBe(true)

    p.destroy()
  })

  it('命令链路：play / pause / mute / setVolume / seek / 全屏 都落到假媒体面', async () => {
    const { Ctor } = makeFakeKernel()
    const p = new Player(
      { container: '#mini', url: 'https://cdn/live.m3u8', kernel: Ctor } as never,
      makePlatform(surface, host, Ctor) as never,
    )
    await p.play()

    p.mute(true)
    p.setVolume(0.3)
    p.seek(10) // 直播 duration 有限时可用（假的 duration=7200）
    p.requestFullscreen()
    p.exitFullscreen()
    p.pause()

    expect(surface.calls).toEqual(expect.arrayContaining(['play', 'pause', 'seek:10', 'requestFullscreen', 'exitFullscreen']))
    expect(surface.muted).toBe(true)
    expect(surface.volume).toBe(0.3)
    expect(p.getState().muted).toBe(true)
    expect(p.getState().volume).toBe(0.3)
    expect(p.getState().playing).toBe(false)

    p.destroy()
  })

  it('媒体能力查询：`player.canPlay(mime)` 转发给平台，无需 canPlayType', async () => {
    const { Ctor } = makeFakeKernel()
    const p = new Player(
      { container: '#mini', url: 'https://cdn/live.m3u8', kernel: Ctor } as never,
      makePlatform(surface, host, Ctor) as never,
    )

    // 假媒体面声明「本宿主原生就能播 HLS」—— 这正是它进契约的理由：
    // core 只转发结果，不解释、也不需要知道 Web 的 canPlayType 三态。
    expect(p.canPlay('application/vnd.apple.mpegurl')).toBe(true)
    expect(surface.calls).toContain('canPlay:application/vnd.apple.mpegurl')
    // 别的 MIME 由平台自己判否
    expect(p.canPlay('video/mp4')).toBe(false)

    p.destroy()
  })

  it('封面图层走承载面契约（core 不再自己建 <img>）', async () => {
    const { Ctor } = makeFakeKernel()
    const p = new Player(
      { container: '#mini', url: 'https://cdn/live.m3u8', kernel: Ctor, posterMode: 'overlay' } as never,
      makePlatform(surface, host, Ctor) as never,
    )
    await p.play()
    p.setPoster('https://cdn/cover.jpg')
    expect(host.calls).toContain('poster:https://cdn/cover.jpg')

    p.setPoster(undefined)
    expect(host.calls).toContain('poster:hide')

    p.destroy()
  })

  it('零尺寸告警：用承载面的 measure()，且**「测不到」不告警**（假平台自己给提示文案）', async () => {
    const { Ctor } = makeFakeKernel()

    // ① 真的是 0 → 告警一次，并带上平台提供的排查提示
    const zeroHost = makeFakeHost(() => ({ width: 0, height: 0 }))
    const p1 = new Player(
      { container: '#mini', url: 'https://cdn/live.m3u8', kernel: Ctor } as never,
      makePlatform(surface, zeroHost, Ctor) as never,
    )
    await p1.play()
    await p1.play() // 再起播一次：仍只告警一次
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('容器尺寸为 0（0×0）')
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('假平台提示')
    p1.destroy()

    // ② 测不到尺寸（null）→ **不告警**（与「真的是 0」严格区分）
    warnSpy.mockClear()
    const nullHost = makeFakeHost(() => null)
    const p2 = new Player(
      { container: '#mini', url: 'https://cdn/live.m3u8', kernel: Ctor } as never,
      makePlatform(surface, nullHost, Ctor) as never,
    )
    await p2.play()
    expect(warnSpy).not.toHaveBeenCalled()
    p2.destroy()
  })

  it('销毁：媒体面与承载面各收到一次 destroy，事件订阅被解绑', () => {
    const { Ctor } = makeFakeKernel()
    const p = new Player({ container: '#mini', kernel: Ctor } as never, makePlatform(surface, host, Ctor) as never)
    p.destroy()
    p.destroy() // 幂等

    expect(surface.calls.filter((c) => c === 'destroy')).toHaveLength(1)
    expect(host.calls.filter((c) => c === 'destroy')).toHaveLength(1)
    expect(surface.calls).toContain('off:fullscreenchange') // 订阅已解绑
  })

  it('容器解析失败：构造抛错且不留副作用（媒体面被回收）', () => {
    const { Ctor } = makeFakeKernel()
    const throwingHost = makeFakeHost()
    throwingHost.mount = () => {
      throw new Error('[live-sdk] container 未找到：#nope')
    }
    expect(
      () => new Player({ container: '#nope', kernel: Ctor } as never, makePlatform(surface, throwingHost, Ctor) as never),
    ).toThrow(/container 未找到/)
    expect(surface.calls).toContain('destroy')
  })
})
