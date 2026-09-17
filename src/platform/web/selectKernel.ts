/**
 * Web 内核选路：`内核选路 = f(源格式, 平台能力, 观测档位)`（spec §7.2）。
 *
 * 由 `core/Player#selectKernel` 迁移而来（P0 解耦）。之所以必须搬出 core：
 * 它要 `import` 具体的 `HlsKernel` / `NativeKernel`（进而 `import 'hls.js'`），
 * 是 core 反向依赖实现层的最大一处。
 *
 * 注意「默认内核的选择属于平台」这条结论 —— core 保留的只是
 * 「接入方显式指定 `config.kernel` 时优先」这一条平台无关的判断。
 */
import type { KernelConstructor, Observability } from '../../types'
import { HlsKernel } from '../../kernel/HlsKernel'
import { NativeKernel } from '../../kernel/NativeKernel'
import { canPlayNativeHLS, canPlayNativeMP4, supportsMSE } from '../../utils/sniffer'

export function selectWebKernel(media: HTMLVideoElement, observability: Observability): KernelConstructor {
  if (observability === 'full') {
    if (HlsKernel.isSupported()) return HlsKernel
    return NativeKernel // 无 MSE（Safari <17.1）→ 原生 HLS，深度观测落 basic
  }
  // basic
  if (canPlayNativeHLS(media)) return NativeKernel
  if (canPlayNativeMP4(media)) return NativeKernel // 渐进式 MP4 直连
  if (supportsMSE() && HlsKernel.isSupported()) return HlsKernel
  throw new Error('平台不支持任何可用播放内核')
}
