import { test, expect, type Page } from '@playwright/test'

/**
 * live-sdk E2E —— 验证「内核 → Player → UI」这条端到端链路。
 *
 * 覆盖原则：只测**必须跨层才能发现**的问题。
 * 纯逻辑（退避公式、buffer 口径、状态迁移表）已在 Vitest 覆盖，这里不重复。
 * 这里盯的是三类东西：
 *   1. 装配正确性：注入的内核是否真被选中、UI 是否挂上、事件是否冒泡到 window 层
 *   2. 跨层联动：内核抛错 → 状态机 → 按钮图标的连锁反应（单测里 UI 是被 stub 的）
 *   3. 真实浏览器 API：Pointer Events 语义、object URL 生命周期、destroy 后的 DOM 残留
 */

/** 等 harness 把 __e2e 挂到 window 上 */
async function boot(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/test/e2e/harness.html')
  await page.waitForFunction(() => (window as never as { __e2e?: { ready?: boolean } }).__e2e?.ready === true)
  return errors
}

/** 读取当前 Player 状态 */
function state(page: Page) {
  return page.evaluate(() => (window as never as { __e2e: { state: () => Record<string, unknown> } }).__e2e.state())
}

/** 驱动内核派发事件 */
function emit(page: Page, event: string, data?: unknown) {
  return page.evaluate(
    ([e, d]) => (window as never as { __e2e: { emit: (e: string, d?: unknown) => void } }).__e2e.emit(e as string, d),
    [event, data] as const,
  )
}

// ═══════════════════════ 1. 装配与冒烟 ═══════════════════════

test.describe('装配', () => {
  test('harness 启动无 pageerror，注入的内核被选中', async ({ page }) => {
    const errors = await boot(page)
    expect(errors).toEqual([])

    // 注入 kernel 后，selectKernel 必须尊重它（而不是被 sniffer 覆盖）
    const caps = await page.evaluate(() => {
      const s = (window as never as { __e2e: { state: () => { capabilities: Record<string, unknown> } } }).__e2e.state()
      return s.capabilities
    })
    expect(caps.qualitySwitch).toBe(true)
    expect(caps.abr).toBe(true)
  })

  test('默认 UI 已挂载，video 在容器内', async ({ page }) => {
    await boot(page)
    await expect(page.locator('#player video')).toHaveCount(1)
    await expect(page.locator('#player')).not.toBeEmpty()
  })

  test('起播后 load 被调用，manifest_parsed 推进到 ready/playing', async ({ page }) => {
    await boot(page)
    await expect.poll(async () => (await state(page)).status, { timeout: 5000 }).not.toBe('loading')
    const reloadCount = await page.evaluate(
      () => (window as never as { __e2e: { reloadCount: number } }).__e2e.reloadCount,
    )
    expect(reloadCount).toBeGreaterThanOrEqual(1)
  })
})

// ═══════════════════════ 2. 断流 → 重连 → 恢复（跨层联动） ═══════════════════════

test.describe('断流恢复', () => {
  test('网络错误 → 触发重连并派发 retry 事件', async ({ page }) => {
    await boot(page)
    const retryPromise = page.evaluate(
      () =>
        new Promise<{ retryCount: number; delay: number }>((resolve) => {
          ;(window as never as { __e2e: { player: { on: Function } } }).__e2e.player.on(
            'retry',
            (payload: { retryCount: number; delay: number }) => resolve(payload),
          )
        }),
    )

    await emit(page, 'error', { details: 'NETWORK_ERROR', fatal: false, message: 'mock 断流' })
    const payload = await retryPromise
    expect(payload.retryCount).toBe(1)
    expect(payload.delay).toBeGreaterThan(0)
  })

  test('同类错误在 10s 窗口内只重连一次（防重试风暴）', async ({ page }) => {
    await boot(page)
    const before = await page.evaluate(
      () => (window as never as { __e2e: { reloadCount: number } }).__e2e.reloadCount,
    )

    // 连续三次同类错误 —— 只有第一条应触发重连
    await emit(page, 'error', { details: 'NETWORK_ERROR', fatal: false, message: 'mock 1' })
    await emit(page, 'error', { details: 'NETWORK_ERROR', fatal: false, message: 'mock 2' })
    await emit(page, 'error', { details: 'NETWORK_ERROR', fatal: false, message: 'mock 3' })

    // 退避延迟从 1000ms 起，留足时间让第一条的 reload 落地
    await page.waitForTimeout(2000)
    const after = await page.evaluate(
      () => (window as never as { __e2e: { reloadCount: number } }).__e2e.reloadCount,
    )
    // 相比初始只会多 1 次（第一条），另两条被去重拦下
    expect(after - before).toBe(1)
  })
})

// ═══════════════════════ 3. 近尾卡顿 → ended（非重连） ═══════════════════════

test.describe('近尾卡顿判定', () => {
  test('buffer 贴近末尾时 stalled → ended，不触发重连', async ({ page }) => {
    await boot(page)
    const before = await page.evaluate(
      () => (window as never as { __e2e: { reloadCount: number } }).__e2e.reloadCount,
    )

    // 造一个「有明确时长 + 播放点/buffer 双双贴近末尾」的场景
    await page.evaluate(() => {
      const v = document.querySelector('#player video') as HTMLVideoElement
      Object.defineProperty(v, 'duration', { configurable: true, get: () => 100 })
      v.currentTime = 99.8
      ;(window as never as { __e2e: { setBuffered: (r: Array<[number, number]>) => void } }).__e2e.setBuffered([
        [0, 100],
      ])
    })

    const endedPromise = page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          ;(window as never as { __e2e: { player: { on: Function } } }).__e2e.player.on('ended', () => resolve(true))
          setTimeout(() => resolve(false), 4000)
        }),
    )

    // 先进入 playing，再制造 stalled
    await emit(page, 'manifest_parsed', { levels: [] })
    await page.waitForTimeout(100)
    await page.evaluate(() => {
      const v = document.querySelector('#player video') as HTMLVideoElement
      v.dispatchEvent(new Event('playing'))
      v.dispatchEvent(new Event('waiting'))
    })

    expect(await endedPromise).toBe(true)
    const after = await page.evaluate(
      () => (window as never as { __e2e: { reloadCount: number } }).__e2e.reloadCount,
    )
    expect(after - before).toBe(0) // 未重连
  })

  test('直播无限流（duration=Infinity）卡顿 → 仍走重连，不误判 ended', async ({ page }) => {
    await boot(page)
    const before = await page.evaluate(
      () => (window as never as { __e2e: { reloadCount: number } }).__e2e.reloadCount,
    )

    await page.evaluate(() => {
      const v = document.querySelector('#player video') as HTMLVideoElement
      Object.defineProperty(v, 'duration', { configurable: true, get: () => Infinity })
    })
    await emit(page, 'manifest_parsed', { levels: [] })
    await page.waitForTimeout(100)
    await page.evaluate(() => {
      const v = document.querySelector('#player video') as HTMLVideoElement
      v.dispatchEvent(new Event('playing'))
      v.dispatchEvent(new Event('waiting'))
    })

    // 卡顿超时后应触发重连（走 stalled→timeout→retry 而非 ended）
    await expect
      .poll(
        async () =>
          (await page.evaluate(
            () => (window as never as { __e2e: { reloadCount: number } }).__e2e.reloadCount,
          )) - before,
        { timeout: 20_000 },
      )
      .toBeGreaterThanOrEqual(1)
  })
})

// ═══════════════════════ 4. UI 交互（Pointer Events） ═══════════════════════

test.describe('UI 交互', () => {
  test('播放/暂停按钮：pointerdown 单击只切一次（无 click+touch 双触发）', async ({ page }) => {
    await boot(page)
    const btn = page.locator('#player').locator('button').first()
    await expect(btn).toBeVisible()

    const readIcon = () =>
      page.evaluate(() => {
        const b = document.querySelector('#player button') as HTMLElement
        return b.getAttribute('aria-label') || b.textContent || ''
      })

    const a = await readIcon()
    await btn.click()
    await page.waitForTimeout(150)
    const b = await readIcon()
    // 一次点击后图标应发生一次翻转
    expect(b).not.toBe(a)
  })
})

// ═══════════════════════ 5. destroy 清理 ═══════════════════════

test.describe('destroy', () => {
  test('destroy 后容器清空、可重复调用不抛错', async ({ page }) => {
    const errors = await boot(page)
    const result = await page.evaluate(() => {
      const e2e = (window as never as { __e2e: { player: { destroy: () => void } } }).__e2e
      e2e.player.destroy()
      e2e.player.destroy() // 幂等
      return {
        playerChildren: document.querySelector('#player')?.children.length ?? -1,
        bodyHasVideo: document.querySelectorAll('video').length,
      }
    })
    expect(result.playerChildren).toBe(0)
    expect(result.bodyHasVideo).toBe(0)
    expect(errors).toEqual([])
  })
})
