import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installDom, makeEl, type FakeMediaElement } from './fixtures/dom'

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
  dom.reset()
})

function createPlayer(config: Record<string, unknown> = {}): PlayerInstance {
  return new PlayerCtor({
    container: '#c',
    kernel: makeMockKernel() as never,
    ...config,
  } as never)
}

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
