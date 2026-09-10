/** 分级 logger：开发态输出，可被 Reporter 采集（控制台与上报双通道） */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const PREFIX = '[live-sdk]'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

let globalLevel: LogLevel = 'info'

export function setLogLevel(level: LogLevel): void {
  globalLevel = level
}

function write(level: LogLevel, args: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[globalLevel]) return
  const fn = (console as unknown as Record<string, (...a: unknown[]) => void>)[level] ?? console.log
  fn(PREFIX, ...args)
}

export const logger: Logger = {
  debug: (...args) => write('debug', args),
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args),
}
