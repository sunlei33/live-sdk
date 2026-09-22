/**
 * Web 内核选路：`内核选路 = f(源格式, 平台能力, 观测档位)`（spec §7.2）。
 *
 * 由 `core/Player#selectKernel` 迁移而来（P0 解耦）。之所以必须搬出 core：
 * 它要 `import` 具体的 `HlsKernel` / `NativeKernel`（进而 `import 'hls.js'`），
 * 是 core 反向依赖实现层的最大一处。
 *
 * 注意「默认内核的选择属于平台」这条结论 —— core 保留的只是
 * 「接入方显式指定 `config.kernel` 时优先」这一条平台无关的判断。
 *
 * 两项能力探测的取处不同（见 `./capabilities.ts` 的说明）：
 * - **宿主能力** `supportsMSE()` —— 问 `window`；
 * - **媒体设备能力** `media.canPlay(mime)` —— 问媒体面契约（换宿主时由宿主自己回答）。
 */
import type { KernelConstructor, MediaSurface, Observability } from '../../types'
import { HlsKernel } from '../../kernel/HlsKernel'
import { NativeKernel } from '../../kernel/NativeKernel'
import { MIME_HLS, MIME_MP4, supportsMSE } from './capabilities'
import { bi } from '../../utils/i18n'

export function selectWebKernel(media: MediaSurface, observability: Observability): KernelConstructor {
  if (observability === 'full') {
    if (HlsKernel.isSupported()) return HlsKernel
    return NativeKernel // 无 MSE（Safari <17.1）→ 原生 HLS，深度观测落 basic
  }
  // basic
  if (media.canPlay(MIME_HLS)) return NativeKernel
  if (media.canPlay(MIME_MP4)) return NativeKernel // 渐进式 MP4 直连
  if (supportsMSE() && HlsKernel.isSupported()) return HlsKernel
  throw new Error(bi('平台不支持任何可用播放内核', 'the platform supports no usable playback kernel'))
}
