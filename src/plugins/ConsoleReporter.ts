import { BasePlugin } from '../core/BasePlugin'
import type { ReportRecord } from '../types'

/**
 * ConsoleReporter：默认上报插件（开发态，控制台输出）。
 * 只负责「往哪发」，SDK 已完成分级/节流/采样后再广播到这里。
 */
export class ConsoleReporter extends BasePlugin {
  static readonly pluginName = 'reporter'

  report(record: ReportRecord): void {
    const fn =
      record.level === 'fatal'
        ? console.error
        : record.level === 'warn'
          ? console.warn
          : console.info
    fn(`[live-sdk:${record.type}]`, record.code, record.data)
  }

  flush(): void {
    // 控制台无缓存，空实现
  }
}
