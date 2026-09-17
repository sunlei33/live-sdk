import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installDom, makeEl, type FakeMediaElement } from './fixtures/dom'
import { Events, BUFFER_LEVEL_THRESHOLDS, bufferLevelOf } from '../src/constants'

type Dom = ReturnType<typeof installDom>
type PlayerInstance = import('../src/core/Player').Player

let dom: Dom
let video: FakeMediaElement
let PlayerCtor: typeof import('../src/core/Player').Player
/** P0：`Player` 需注入平台装配包；测试用真实 Web 实现（动态导入，等 DOM 就绪） */
let createWebPlatform: typeof import('../src/platform/web').createWebPlatform

/**
 * 最小内核替身（与 player.test.ts 同构），额外把 switchQuality / load 变为可观测。
 *
 * `static last` 是必要的：`Player` 在**首次 `play()` 时**才惰性 `new` 内核，
 * 构造函数之后 `player.getKernel()` 仍为 `null`，测试拿不到实例。
 */
function makeMockKernel() {
  return class MockKernel {
    static readonly kernelName = 'MockKernel'
    static last: MockKernel | null = null
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
    readonly switches: number[] = []
    switchURLCount = 0
    loadCount = 0
    private onEvent: (e: string, d?: unknown) => void
    constructor(opts: { onEvent: (e: string, d?: unknown) => void }) {
      MockKernel.last = this
      this.onEvent = opts.onEvent
    }
    async load(): Promise<void> {
      this.loadCount++
      this.onEvent('manifest_parsed', {})
    }
    async switchURL(): Promise<void> {
      this.switchURLCount++
    }
    switchQuality(levelIndex: number): void {
      this.switches.push(levelIndex)
    }
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
  video = dom.els['video'] ?? (dom.els['video'] = makeEl('video'))
  PlayerCtor ??= (await import('../src/core/Player')).Player
  createWebPlatform ??= (await import('../src/platform/web')).createWebPlatform
})

afterEach(() => {
  dom.reset()
})

function createPlayer(kernel: unknown = makeMockKernel()): PlayerInstance {
  return new PlayerCtor({ container: '#c', kernel } as never, createWebPlatform({ kernel: kernel as never }) as never)
}

/** 起播一次以内核就绪（内核是惰性创建的），并让状态机进入可用的会话态 */
async function createStarted(kernel?: unknown): Promise<PlayerInstance> {
  const p = createPlayer(kernel)
  await p.play({ url: 'https://live.m3u8' })
  return p
}

/** 内核：`bufferInfo()` 的 remaining 由外部可变状态驱动 */
function makeBufferKernel(state: { remaining: number }) {
  const Base = makeMockKernel()
  return class extends Base {
    bufferInfo() {
      const r = state.remaining
      return {
        buffers: [[0, r]] as [number, number][],
        behind: 3,
        remaining: r,
        length: r,
        totalRemaining: r + 7,
        totalLength: r + 7,
      }
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PLAY —— 0.3.0 及之前是「声明了但全仓库零 emit」的死事件，本组为回归测试
// ════════════════════════════════════════════════════════════════════════════
describe('Events.PLAY 活性（回归：曾是死事件）', () => {
  it('media `play` 事件 → 派发 PLAY', () => {
    const p = createPlayer()
    const got: unknown[] = []
    p.on(Events.PLAY, () => got.push(true))
    video._fire('play')
    expect(got.length).toBe(1)
  })

  it('PLAY 先于 PLAYING（请求被接受 vs 真正出画）', () => {
    const p = createPlayer()
    const seq: string[] = []
    p.on(Events.PLAY, () => seq.push('PLAY'))
    p.on(Events.PLAYING, () => seq.push('PLAYING'))
    // 真实浏览器顺序：play() 后先 `play`，再 `playing`
    video._fire('play')
    video._fire('playing')
    expect(seq).toEqual(['PLAY', 'PLAYING'])
  })

  it('PLAY 与 PAUSE 成对：每次起播 / 每次暂停各一次', async () => {
    // 需先起播：状态机要走 load → (manifestParsed) → ready 才允许 play → playing，
    // 否则 onMediaPause 的首帧前噪声抑制会把 pause 吞掉（那是刻意的防误报）。
    const p = await createStarted()
    const seq: string[] = []
    p.on(Events.PLAY, () => seq.push('PLAY'))
    p.on(Events.PAUSE, () => seq.push('PAUSE'))
    video._fire('play')
    video._fire('playing') // 进入 playing，pause 才不会被首帧前噪声抑制挡掉
    video._fire('pause')
    video._fire('play')
    expect(seq).toEqual(['PLAY', 'PAUSE', 'PLAY'])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// BUFFER_UPDATE —— 同为死事件；现按「水位档位跨越」派发
// ════════════════════════════════════════════════════════════════════════════
describe('Events.BUFFER_UPDATE 活性（回归：曾是死事件）', () => {
  it('bufferLevelOf 按 BUFFER_LEVEL_THRESHOLDS 分档（边界取「达到」）', () => {
    expect(BUFFER_LEVEL_THRESHOLDS).toEqual([1, 3, 5, 10, 20])
    expect(bufferLevelOf(0)).toBe(0)
    expect(bufferLevelOf(0.99)).toBe(0)
    expect(bufferLevelOf(1)).toBe(1) // 恰好命中边界 → 计入该档
    expect(bufferLevelOf(4)).toBe(2)
    expect(bufferLevelOf(9.9)).toBe(3)
    expect(bufferLevelOf(20)).toBe(5)
    expect(bufferLevelOf(999)).toBe(5) // 封顶
  })

  it('media `progress` → 派发，且载荷带全量 BufferInfo + level', async () => {
    const state = { remaining: 4 }
    const p = await createStarted(makeBufferKernel(state))
    const got: Array<Record<string, unknown>> = []
    p.on(Events.BUFFER_UPDATE, (e) => got.push(e as never))
    video._fire('progress')
    expect(got.length).toBe(1)
    expect(got[0]).toMatchObject({ level: 2, remaining: 4, totalRemaining: 11, behind: 3 })
  })

  it('同一档位内反复 progress 不会重复派发（这是它没挂在 timeupdate 上的原因）', async () => {
    const state = { remaining: 4 }
    const p = await createStarted(makeBufferKernel(state))
    let n = 0
    p.on(Events.BUFFER_UPDATE, () => n++)
    video._fire('progress')
    state.remaining = 4.2
    video._fire('progress')
    state.remaining = 4.9
    video._fire('progress')
    expect(n).toBe(1) // 始终在档位 2
  })

  it('档位变化才派发：0 → 2 → 0', async () => {
    const state = { remaining: 0.5 }
    const p = await createStarted(makeBufferKernel(state))
    const levels: number[] = []
    p.on(Events.BUFFER_UPDATE, (e) => levels.push((e as { level: number }).level))
    video._fire('progress') // level 0
    state.remaining = 4
    video._fire('progress') // level 2
    state.remaining = 4.5
    video._fire('progress') // 仍是 2，不派发
    state.remaining = 0.2
    video._fire('progress') // 回落到 0（低缓冲预警场景）
    expect(levels).toEqual([0, 2, 0])
  })

  it('新一轮起播重置节流状态 —— 起播瞬间的低水位不会被上一轮吞掉', async () => {
    const state = { remaining: 0.1 }
    const p = await createStarted(makeBufferKernel(state))
    const levels: number[] = []
    p.on(Events.BUFFER_UPDATE, (e) => levels.push((e as { level: number }).level))
    video._fire('progress') // 档位 0
    await p.play({ url: 'https://live.m3u8' }) // 新会话 → 节流状态清零
    video._fire('progress')
    expect(levels).toEqual([0, 0])
  })

  it('按当前块（remaining）而非全量并集分档：孤岛场景不误报充裕', async () => {
    const state = { remaining: 0.4 }
    const p = await createStarted(makeBufferKernel(state))
    let level = -1
    p.on(Events.BUFFER_UPDATE, (e) => (level = (e as { level: number }).level))
    video._fire('progress')
    // totalRemaining=7.4 落在档位 3，但当前播放块只剩 0.4s → 真实判据是 0
    expect(level).toBe(0)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Hooks 接线 —— 0.3.0 及之前 runHooks 在 src/ 内无任何调用方
// ════════════════════════════════════════════════════════════════════════════
describe('Hooks 接线（回归：此前 runHooks 无调用点）', () => {
  it('switchQuality：before 钩子写回 cancelled=true 可拦截内置逻辑', async () => {
    const K = makeMockKernel()
    const p = await createStarted(K)
    const kernel = K.last!
    const abr: unknown[] = []
    p.on(Events.ABR_CHANGE, (e) => abr.push(e))
    p.useHooks('switchQuality', (ctx) => {
      if (ctx.phase === 'before') ctx.cancelled = true
      return
    })
    await p.switchQuality(-1)
    expect(kernel.switches).toEqual([]) // 未触达内核
    expect(abr).toEqual([]) // 也未派发事件
  })

  it('switchQuality：不拦截时正常执行，after 钩子拿到 applied=true', async () => {
    const K = makeMockKernel()
    const p = await createStarted(K)
    const kernel = K.last!
    const phases: Array<[string, boolean]> = []
    p.useHooks('switchQuality', (ctx) => {
      if (ctx.phase === 'after') phases.push([ctx.phase, ctx.applied as boolean])
      return
    })
    await p.switchQuality(-1)
    expect(kernel.switches).toEqual([-1])
    expect(phases).toEqual([['after', true]])
  })

  it('switchQuality：内核不支持切档 → after 钩子拿到 applied=false', async () => {
    const K = makeMockKernel()
    const p = await createStarted(K)
    const kernel = K.last!
    ;(kernel.capabilities as { qualitySwitch: boolean }).qualitySwitch = false
    let applied: boolean | undefined
    p.useHooks('switchQuality', (ctx) => {
      if (ctx.phase === 'after') applied = ctx.applied as boolean
      return
    })
    await p.switchQuality(-1)
    expect(kernel.switches).toEqual([])
    expect(applied).toBe(false)
  })

  it('switchQuality：id 不在档位表 → applied=false（与内核不支持可区分）', async () => {
    const K = makeMockKernel()
    const p = await createStarted(K)
    const kernel = K.last!
    let applied: boolean | undefined
    p.useHooks('switchQuality', (ctx) => {
      if (ctx.phase === 'after') applied = ctx.applied as boolean
      return
    })
    await p.switchQuality(42) // mock 内核 getLevels() 为空 → qualityMap 里没有 42
    expect(kernel.switches).toEqual([])
    expect(applied).toBe(false)
  })

  it('switchURL：before 钩子可拦截，after 成功后触发且带 url', async () => {
    const K = makeMockKernel()
    const p = await createStarted(K)
    const kernel = K.last!
    const seen: Array<[string, string]> = []
    p.useHooks('switchURL', (ctx) => {
      seen.push([ctx.phase as string, ctx.url as string])
      if (ctx.phase === 'before') ctx.cancelled = true
      return
    })
    await p.switchURL('https://backup.m3u8')
    expect(seen).toEqual([['before', 'https://backup.m3u8']]) // 被拦截 → 无 after
    expect(kernel.switchURLCount).toBe(0)
  })

  it('switchURL：未拦截时执行并在成功后触发 after（applied=true）', async () => {
    const K = makeMockKernel()
    const p = await createStarted(K)
    const kernel = K.last!
    const seen: Array<[string, boolean]> = []
    p.useHooks('switchURL', (ctx) => {
      if (ctx.phase === 'after') seen.push([ctx.phase, ctx.applied as boolean])
      return
    })
    await p.switchURL('https://backup.m3u8')
    expect(kernel.switchURLCount).toBe(1)
    expect(seen).toEqual([['after', true]])
  })

  it('play：before 钩子可拦截起播（内核 load 不被调用）', async () => {
    const K = makeMockKernel()
    const p = createPlayer(K)
    p.useHooks('play', (ctx) => {
      if (ctx.phase === 'before') ctx.cancelled = true
      return
    })
    await p.play({ url: 'https://live.m3u8' })
    expect(K.last).toBeNull() // 内核根本没被创建
  })

  it('play：正常起播后 after 钩子触发，ctx.input 透传原始入参', async () => {
    const p = createPlayer()
    const after: unknown[] = []
    p.useHooks('play', (ctx) => {
      if (ctx.phase === 'after') after.push(ctx.input)
      return
    })
    await p.play({ url: 'https://live.m3u8' })
    expect(after).toEqual([{ url: 'https://live.m3u8' }])
  })

  it('钩子可异步（返回 Promise 时被 await 后才继续内置逻辑）', async () => {
    const K = makeMockKernel()
    const p = await createStarted(K)
    const kernel = K.last!
    const order: string[] = []
    p.useHooks('switchQuality', async (ctx) => {
      if (ctx.phase !== 'before') return
      await new Promise((r) => setTimeout(r, 5))
      order.push('hook-done')
    })
    await p.switchQuality(-1)
    order.push('command-returned')
    expect(order).toEqual(['hook-done', 'command-returned'])
    expect(kernel.switches).toEqual([-1])
  })
})
