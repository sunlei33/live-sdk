import { describe, it, expect } from 'vitest'
import { bi } from '../src/utils/i18n'

describe('bi：运行期消息的双语拼接（中文在前、英文在后）', () => {
  it('以 ` / ` 分隔，顺序固定为「中文 / English」', () => {
    expect(bi('缓冲停滞超时', 'buffer stalled, timed out')).toBe('缓冲停滞超时 / buffer stalled, timed out')
  })

  it('动态值由调用方插值后原样保留（不在内部做格式化）', () => {
    expect(bi(`加载超时（${1200}ms）`, `Load timed out (${1200}ms)`)).toBe('加载超时（1200ms） / Load timed out (1200ms)')
  })

  it('不做语言回退或省略：两者都原样拼接（含空串）', () => {
    // 空值不是「未提供」的语义 —— 调用方传什么就拼什么，避免在这里悄悄改变消息含义
    expect(bi('', 'only english')).toBe(' / only english')
    expect(bi('只有中文', '')).toBe('只有中文 / ')
  })
})
