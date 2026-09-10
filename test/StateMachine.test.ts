import { describe, it, expect } from 'vitest'
import { StateMachine, type StateMachineEvent } from '../src/core/StateMachine'
import type { SessionState } from '../src/constants'

/** 走一条事件路径，返回最终状态 */
function walk(sm: StateMachine, events: StateMachineEvent[]): SessionState {
  for (const e of events) sm.transition(e)
  return sm.current
}

describe('StateMachine 状态表', () => {
  it('初始态为 idle', () => {
    expect(new StateMachine().current).toBe('idle')
  })

  it('正常起播路径 idle→loading→ready→playing', () => {
    const sm = new StateMachine()
    expect(walk(sm, ['load', 'manifestParsed', 'play'])).toBe('playing')
  })

  it('暂停/恢复路径 playing→paused→playing', () => {
    const sm = new StateMachine()
    walk(sm, ['load', 'manifestParsed', 'play'])
    expect(walk(sm, ['pause'])).toBe('paused')
    expect(walk(sm, ['play'])).toBe('playing')
  })

  it('卡顿恢复路径 playing→stalled→playing', () => {
    const sm = new StateMachine()
    walk(sm, ['load', 'manifestParsed', 'play', 'stall'])
    expect(sm.current).toBe('stalled')
    expect(walk(sm, ['recovered'])).toBe('playing')
  })

  it('卡顿超时 → error → retry → loading（断流重连）', () => {
    const sm = new StateMachine()
    walk(sm, ['load', 'manifestParsed', 'play', 'stall', 'timeout'])
    expect(sm.current).toBe('error')
    expect(walk(sm, ['retry'])).toBe('loading')
  })

  it('近尾卡顿可直达 ended（stalled→ended）', () => {
    const sm = new StateMachine()
    walk(sm, ['load', 'manifestParsed', 'play', 'stall'])
    expect(walk(sm, ['ended'])).toBe('ended')
  })

  it('playing 直达 ended（正常播完）', () => {
    const sm = new StateMachine()
    walk(sm, ['load', 'manifestParsed', 'play'])
    expect(walk(sm, ['ended'])).toBe('ended')
  })

  it('ended 后可重播 playing / 重新 loading', () => {
    const sm = new StateMachine()
    walk(sm, ['load', 'manifestParsed', 'play', 'ended'])
    expect(walk(sm, ['play'])).toBe('playing')

    const sm2 = new StateMachine()
    walk(sm2, ['load', 'manifestParsed', 'play', 'ended'])
    expect(walk(sm2, ['load'])).toBe('loading')
  })

  it('非法事件不迁移且返回 false（idle 不能直接 play）', () => {
    const sm = new StateMachine()
    expect(sm.transition('play')).toBe(false)
    expect(sm.current).toBe('idle')
  })

  it('非法事件不触发监听器', () => {
    const sm = new StateMachine()
    let called = 0
    sm.onChange(() => called++)
    sm.transition('play') // idle 下非法
    expect(called).toBe(0)
    sm.transition('load') // 合法
    expect(called).toBe(1)
  })

  it('can() 正确预告可迁移性', () => {
    const sm = new StateMachine()
    expect(sm.can('load')).toBe(true)
    expect(sm.can('play')).toBe(false)
    sm.transition('load')
    expect(sm.can('manifestParsed')).toBe(true)
    expect(sm.can('play')).toBe(false)
  })

  it('onChange 携带 next/prev，unsubscribe 后不再回调', () => {
    const sm = new StateMachine()
    const seen: Array<[SessionState, SessionState]> = []
    const off = sm.onChange((next, prev) => seen.push([next, prev]))
    sm.transition('load')
    expect(seen).toEqual([['loading', 'idle']])
    off()
    sm.transition('manifestParsed')
    expect(seen).toHaveLength(1)
  })

  it('reset 回到 idle', () => {
    const sm = new StateMachine()
    walk(sm, ['load', 'manifestParsed', 'play'])
    sm.reset()
    expect(sm.current).toBe('idle')
  })

  it('全路径覆盖：error → retry → loading → ready → playing 可回到播放', () => {
    const sm = new StateMachine()
    const states = walk(sm, [
      'load',
      'manifestParsed',
      'play',
      'stall',
      'timeout',
      'retry',
      'manifestParsed',
      'play',
    ])
    expect(states).toBe('playing')
  })
})
