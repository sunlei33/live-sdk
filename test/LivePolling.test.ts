import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { installDom } from './fixtures/dom'
import { LivePolling, LIVE_STATUS_ERROR_EVENT } from '../src/plugins/LivePolling'
import type { LiveStatusPayload, LiveStatusErrorPayload } from '../src/types'

type Dom = ReturnType<typeof installDom>

const realFetch = globalThis.fetch
let dom: Dom

/**
 * 挂载插件：`BasePlugin#emit` 只是把事件转发给 player 的事件总线，
 * 因此一个只实现 `emit` 的替身就足够驱动断言，无需搭整台播放器。
 */
function mount(plugin: LivePolling) {
  const events: Array<{ event: string; data: unknown }> = []
  ;(plugin as unknown as { player: unknown }).player = {
    emit: (event: string, data?: unknown) => events.push({ event, data }),
    on: () => () => {},
  }
  return {
    statuses: () => events.filter((e) => e.event === 'live_status').map((e) => e.data as LiveStatusPayload),
    errors: () => events.filter((e) => e.event === LIVE_STATUS_ERROR_EVENT).map((e) => e.data as LiveStatusErrorPayload),
  }
}

/** 2xx 正常响应替身 */
function ok(json: unknown) {
  return { ok: true, status: 200, json: async () => json }
}

/**
 * 4xx/5xx 响应替身。
 * 关键：`fetch` 对这类响应**不 reject**（只有网络层失败才 reject），
 * 所以它只能靠 `res.ok` 被发现 —— 这正是 D3 的病灶。
 */
function httpError(status: number) {
  return { ok: false, status, json: async () => ({ code: status }) }
}

function setFetch(fn: (...args: unknown[]) => unknown) {
  const spy = vi.fn(fn)
  ;(globalThis as unknown as { fetch: unknown }).fetch = spy
  return spy
}

/** 抓取指定窗口内 logger 的 warn 输出（logger 以 (PREFIX, ...args) 形式调用） */
function captureWarn(): { warns: string[]; restore: () => void } {
  const warns: string[] = []
  const orig = console.warn
  console.warn = (...a: unknown[]) => warns.push(a.map(String).join(' '))
  return { warns, restore: () => (console.warn = orig) }
}

beforeEach(() => {
  dom = installDom()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  ;(globalThis as unknown as { fetch: unknown }).fetch = realFetch
  dom.reset()
})

describe('LivePolling.shouldReportFailure：失败事件的节流判据', () => {
  it('第 1 次即上报 —— 故障要立刻可见', () => {
    expect(LivePolling.shouldReportFailure(1)).toBe(true)
  })

  it('第 2 次不上报 —— 避免连续失败把订阅方刷爆', () => {
    expect(LivePolling.shouldReportFailure(2)).toBe(false)
  })

  it('第 3 / 10 次上报（持续故障仍有心跳式信号）', () => {
    expect(LivePolling.shouldReportFailure(3)).toBe(true)
    expect(LivePolling.shouldReportFailure(10)).toBe(true)
  })

  it('10 之后只按「每满 30 次」上报（29 / 31 静默，30 / 60 上报）', () => {
    expect(LivePolling.shouldReportFailure(29)).toBe(false)
    expect(LivePolling.shouldReportFailure(30)).toBe(true)
    expect(LivePolling.shouldReportFailure(31)).toBe(false)
    expect(LivePolling.shouldReportFailure(59)).toBe(false)
    expect(LivePolling.shouldReportFailure(60)).toBe(true)
  })
})

describe('LivePolling 失败可见性（D1 / D3）', () => {
  it('【回归】HTTP 500 也走失败出口 + 有日志（旧实现是空 catch，连痕迹都没有）', async () => {
    const fetchSpy = setFetch(async () => httpError(500))
    const p = new LivePolling()
    const seen = mount(p)
    const cap = captureWarn()
    try {
      p.start('https://api/status', 1000)
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      cap.restore()
      p.stop()
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(seen.errors()).toHaveLength(1)
    expect(seen.errors()[0]).toMatchObject({ url: 'https://api/status', failCount: 1, error: 'HTTP 500' })
    expect(cap.warns.some((w) => w.includes('[LV-5007]'))).toBe(true)
  })

  it('网络层异常（fetch reject）同样可见，reason 取异常消息', async () => {
    setFetch(async () => {
      throw new Error('Failed to fetch')
    })
    const p = new LivePolling()
    const seen = mount(p)
    p.start('https://api/status', 1000)
    await vi.advanceTimersByTimeAsync(0)
    p.stop()

    expect(seen.errors()).toHaveLength(1)
    expect(seen.errors()[0]).toMatchObject({ failCount: 1, error: 'Failed to fetch' })
    expect(seen.statuses()).toHaveLength(0)
  })

  it('200 但响应无可识别状态字段 → 按失败计（否则会被当成「状态一直没变」）', async () => {
    setFetch(async () => ok({ code: 200, data: null }))
    const p = new LivePolling()
    const seen = mount(p)
    p.start('https://api/status', 1000)
    await vi.advanceTimersByTimeAsync(0)
    p.stop()

    expect(seen.statuses()).toHaveLength(0)
    expect(seen.errors()[0].error).toContain('[LV-5006]')
  })
})

describe('LivePolling 状态归一与去重（D4）', () => {
  it('【回归】数字状态值经 String() 归一，去重不被击穿（旧实现每轮都会误判为「变化」）', async () => {
    const fetchSpy = setFetch(async () => ok({ status: 0 }))
    const p = new LivePolling()
    const seen = mount(p)
    p.start('https://api/status', 1000)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    p.stop()

    expect(fetchSpy).toHaveBeenCalledTimes(3)
    const list = seen.statuses()
    expect(list).toHaveLength(1) // 三轮同值 → 只派发一次
    expect(list[0].status).toBe('0')
    expect(list[0].previousStatus).toBe('')
  })

  it('状态变化才派发，payload 携带 previousStatus 与服务端原始响应', async () => {
    let n = 0
    setFetch(async () => {
      n++
      return ok({ status: n === 1 ? 'not_start' : 'streaming', roomName: '展厅 A' })
    })
    const p = new LivePolling()
    const seen = mount(p)
    p.start('https://api/status', 1000)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    p.stop()

    const list = seen.statuses()
    expect(list.map((x) => [x.previousStatus, x.status])).toEqual([
      ['', 'not_start'],
      ['not_start', 'streaming'],
    ])
    expect(list[1].raw.roomName).toBe('展厅 A')
  })
})

describe('LivePolling 退避与并发（D2 / D5）', () => {
  it('连续失败按 base·2^failCount 退避，成功一次即复位为 base', async () => {
    let n = 0
    const fetchSpy = setFetch(async () => {
      n++
      return n <= 3 ? httpError(503) : ok({ status: 'streaming' })
    })
    const p = new LivePolling()
    mount(p)
    p.start('https://api/status', 1000)

    await vi.advanceTimersByTimeAsync(0) // t=0   首轮失败 → 退避 2s
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1999) // 未到 2s
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1) // t=2000 第 2 轮失败 → 退避 4s
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3999)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1) // t=6000 第 3 轮失败 → 退避 8s
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(7999)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1) // t=14000 成功 → failCount 归零
    expect(fetchSpy).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(1000) // 复位为 base=1s
    expect(fetchSpy).toHaveBeenCalledTimes(5)
    p.stop()
  })

  it('退避间隔受 maxInterval 封顶（不会无限拉长）', async () => {
    const fetchSpy = setFetch(async () => httpError(503))
    const p = new LivePolling()
    p.maxInterval = 3000
    mount(p)
    p.start('https://api/status', 1000)

    await vi.advanceTimersByTimeAsync(0) // t=0    失败 1 → 2s
    await vi.advanceTimersByTimeAsync(2000) // t=2000 失败 2 → min(4s,3s)=3s
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3000) // t=5000 失败 3 → min(8s,3s)=3s
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(2999)
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1) // t=8000
    expect(fetchSpy).toHaveBeenCalledTimes(4)
    p.stop()
  })

  it('stop() 清掉待执行句柄，之后不再发起请求', async () => {
    const fetchSpy = setFetch(async () => ok({ status: 'streaming' }))
    const p = new LivePolling()
    mount(p)
    p.start('https://api/status', 1000)
    await vi.advanceTimersByTimeAsync(0)
    p.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('【回归】stop() 后在途请求返回：不派发结果、也不再续排（不留野定时器）', async () => {
    let release: (v: unknown) => void = () => {}
    const fetchSpy = setFetch(() => new Promise((r) => (release = r)))
    const p = new LivePolling()
    const seen = mount(p)
    p.start('https://api/status', 1000)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    p.stop()
    release(ok({ status: 'streaming' }))
    await vi.advanceTimersByTimeAsync(60_000)

    expect(seen.statuses()).toHaveLength(0)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('【回归】请求在途时重新 start()：不叠加并发，且轮询链不会断', async () => {
    const pending: Array<(v: unknown) => void> = []
    let call = 0
    const fetchSpy = setFetch(() => {
      call++
      if (call === 1) return new Promise((r) => pending.push(r))
      return Promise.resolve(ok({ status: 'streaming' }))
    })
    const p = new LivePolling()
    const seen = mount(p)

    p.start('https://api/old', 1000)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    p.start('https://api/new', 1000) // 旧请求仍在途
    await vi.advanceTimersByTimeAsync(2000)
    expect(fetchSpy).toHaveBeenCalledTimes(1) // 不叠加并发

    pending[0](ok({ status: 'old-status' })) // 旧轮次返回 → 整轮作废
    await vi.advanceTimersByTimeAsync(500)
    expect(seen.statuses()).toHaveLength(0) // 旧地址的结果不得混进新会话

    await vi.advanceTimersByTimeAsync(1000) // 新一轮按 base 间隔发起
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(seen.statuses().map((s) => s.status)).toEqual(['streaming'])
    p.stop()
  })

  it('start() 复位失败计数：重新开始后第一次失败仍会立刻上报', async () => {
    const fetchSpy = setFetch(async () => httpError(503))
    const p = new LivePolling()
    const seen = mount(p)
    p.start('https://api/status', 1000)
    await vi.advanceTimersByTimeAsync(0)
    expect(seen.errors().map((e) => e.failCount)).toEqual([1])

    p.start('https://api/status', 1000) // 重新开始
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(seen.errors().map((e) => e.failCount)).toEqual([1, 1])
    p.stop()
  })

  it('destroy() 停掉轮询', async () => {
    const fetchSpy = setFetch(async () => ok({ status: 'streaming' }))
    const p = new LivePolling()
    mount(p)
    p.start('https://api/status', 1000)
    await vi.advanceTimersByTimeAsync(0)
    p.destroy()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
