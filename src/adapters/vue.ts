/**
 * @sdk/vue（live-sdk/vue）Vue 适配器：usePlayer composable。
 * 内核纯 TS 不绑定框架，框架差异只发生在适配层（spec §3.7）。
 *
 * 与 React 版不同：Vue 中 player 通常只能在 onMounted 后才创建（依赖容器 DOM），
 * 因此 usePlayer 接收 `Ref<Player | null>`，内部 watch 就绪时机后订阅，卸载时清理。
 */
import { onUnmounted, ref, watch, type Ref } from 'vue'
import type { Player } from '../core/Player'
import type { PlayerState } from '../types'

/**
 * 响应式订阅播放器状态：返回快照 ref，模板里 `state?.playing` 直接可用。
 * player 就绪前返回 null，就绪后每次变更收到全量快照。
 *
 * 用法（<script setup>）：
 *   const player = ref<Player | null>(null)
 *   onMounted(() => { player.value = createPlayer({...}) })
 *   const state = usePlayer(player)   // 模板里 v-if="player" 保证非空
 */
export function usePlayer(playerRef: Ref<Player | null>): Readonly<Ref<PlayerState | null>> {
  const state = ref<PlayerState | null>(null)
  let unsub: (() => void) | undefined

  const sync = (): void => {
    unsub?.()
    unsub = undefined
    const p = playerRef.value
    if (p) {
      state.value = p.getState()
      unsub = p.subscribe((s) => {
        state.value = s
      })
    } else {
      state.value = null
    }
  }

  watch(playerRef, sync, { immediate: true })
  onUnmounted(() => unsub?.())

  return state
}
