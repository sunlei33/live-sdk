import { describe, it, expect } from 'vitest'
import { readElementSize, isZeroSized } from '../src/utils/size'

/** 造一个只带所需测量的假元素（结构类型足够，不必是真 DOM） */
function el(over: Record<string, unknown>): Element {
  return over as unknown as Element
}

describe('readElementSize', () => {
  it('优先用 getBoundingClientRect（亚像素精度）', () => {
    const e = el({
      getBoundingClientRect: () => ({ width: 640.5, height: 360.25 }),
      offsetWidth: 640,
      offsetHeight: 360,
    })
    expect(readElementSize(e)).toEqual({ width: 640.5, height: 360.25 })
  })

  it('无 getBoundingClientRect 时回退 offsetWidth/offsetHeight', () => {
    expect(readElementSize(el({ offsetWidth: 300, offsetHeight: 150 }))).toEqual({ width: 300, height: 150 })
  })

  it('getBoundingClientRect 抛错（老 WebView / 已卸载元素）→ 回退 offset', () => {
    const e = el({
      getBoundingClientRect: () => {
        throw new Error('detached')
      },
      offsetWidth: 300,
      offsetHeight: 150,
    })
    expect(readElementSize(e)).toEqual({ width: 300, height: 150 })
  })

  it('getBoundingClientRect 返回残缺对象 → 视为不可用，继续回退', () => {
    const e = el({
      getBoundingClientRect: () => ({ width: undefined, height: undefined }),
      offsetWidth: 200,
      offsetHeight: 100,
    })
    expect(readElementSize(e)).toEqual({ width: 200, height: 100 })
  })

  it('【关键】环境无法测量时返回 null，而非 0', () => {
    // 非浏览器环境 / 自建 DOM 替身都没有这两组属性。若返回 0，
    // 「零尺寸告警」会在测试与 SSR 场景里满屏误报。
    expect(readElementSize(el({}))).toBeNull()
    expect(readElementSize(el({ offsetWidth: 100 }))).toBeNull() // 只有一半
    expect(readElementSize(null)).toBeNull()
    expect(readElementSize(undefined)).toBeNull()
  })

  it('真实为 0 与「测不到」是两回事：0 要如实返回', () => {
    expect(readElementSize(el({ getBoundingClientRect: () => ({ width: 0, height: 0 }) }))).toEqual({
      width: 0,
      height: 0,
    })
  })
})

describe('isZeroSized', () => {
  it('宽或高任一为 0 即零尺寸（必然看不见画面）', () => {
    expect(isZeroSized({ width: 0, height: 0 })).toBe(true)
    expect(isZeroSized({ width: 0, height: 300 })).toBe(true) // 有高度没宽度 → 同样看不见
    expect(isZeroSized({ width: 300, height: 0 })).toBe(true) // 最常见：父级无高度 → height:100% 撑不出
  })

  it('负值也算零尺寸（异常盒模型）', () => {
    expect(isZeroSized({ width: -1, height: 100 })).toBe(true)
  })

  it('两个维度都为正即正常', () => {
    expect(isZeroSized({ width: 1, height: 1 })).toBe(false)
    expect(isZeroSized({ width: 1920, height: 1080 })).toBe(false)
    expect(isZeroSized({ width: 0.5, height: 0.5 })).toBe(false) // 亚像素尺寸仍算可见
  })
})
