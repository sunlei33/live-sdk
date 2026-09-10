/**
 * @sdk/react（live-sdk/react）React 适配器：usePlayer hook。
 * 内核纯 TS 不绑定框架，框架差异只发生在适配层（spec §3.7）。
 * usePlayer = getState() 取初值 + subscribe() 更新 + 卸载清理，一薄层封装。
 */
import { useEffect, useState } from 'react'
import type { Player } from '../core/Player'
import type { PlayerState } from '../types'

/**
 * 响应式订阅播放器状态：任一字段变更触发组件重渲染。
 * 用法：const { playing, muted } = usePlayer(player)
 */
export function usePlayer(player: Player): PlayerState {
  const [state, setState] = useState<PlayerState>(() => player.getState())

  useEffect(() => {
    // 挂载时同步一次最新快照（subscribe 不立即回调），随后每次变更收到全量快照
    setState(player.getState())
    return player.subscribe((s) => setState(s))
  }, [player])

  return state
}
