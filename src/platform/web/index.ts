/**
 * 平台装配包（Web）：把 core 需要的全部平台实现一次性交付。
 *
 * `createPlayer` 调它，把结果作为第二个参数交给 `core/Player`。
 * 这是 P0「解耦」的落点：core 从此不再 `import` 任何实现层模块
 * （`HlsKernel` / `NativeKernel` / `WebEnvAdapter` / `ConsoleReporter` /
 * `LivePolling` / `MediaProxy`），它们全部从这里注入。
 *
 * 将来接其他宿主（小程序 / 原生播放器）时，**再写一份本文件即可**：
 * 换 `media`、`host`、`env`、`selectKernel`、`presets`，core 不需要改。
 */
import type {
  KernelConstructor,
  Observability,
  PlatformAdapters,
  PluginPresetEntry,
} from '../../types'
import { ConsoleReporter } from '../../plugins/ConsoleReporter'
import { LivePolling } from '../../plugins/LivePolling'
import { WebEnvAdapter } from '../../env/WebEnvAdapter'
import { WebMediaSurface } from './WebMediaSurface'
import { WebHost } from './WebHost'
import { selectWebKernel } from './selectKernel'
import { bi } from '../../utils/i18n'

/** 功能插件预设（不含内核 —— 内核由 `config.kernel` / 平台能力选路决定，见 spec §3.5）。 */
const WEB_PRESETS: Record<string, PluginPresetEntry[]> = {
  live: [ConsoleReporter, LivePolling],
  vod: [ConsoleReporter],
}

/**
 * 创建 Web 平台装配包。
 *
 * @param opts.kernel 接入方显式指定的内核（`PlayerConfig.kernel`）——
 *   由 core 优先使用；传进来只是为了让**选路兜底**在同一处表达完整。
 */
export function createWebPlatform(opts: { kernel?: KernelConstructor } = {}): PlatformAdapters<HTMLVideoElement, HTMLElement> {
  const media = new WebMediaSurface()
  const host = new WebHost()
  return {
    media,
    host,
    env: new WebEnvAdapter(),
    selectKernel: (url: string, observability: Observability): KernelConstructor => {
      void url // 当前选路只看平台能力与观测档位，源格式尚未参与（保留入参以便后续按格式分支）
      // 媒体面在这里闭包传入：它是平台自己的对象，无需 core 中转
      return opts.kernel ?? selectWebKernel(media, observability)
    },
    presets: WEB_PRESETS,
    zeroSizeHint: bi(
      '请给容器或其父级确定的高度，例如 style="width:100%;height:300px"。',
      'Give the container or its parent an explicit height, e.g. style="width:100%;height:300px".',
    ),
  }
}
