/**
 * hls.js 的最小桩。
 *
 * dist/live-sdk.es.js 把 hls.js 声明为 external，产物里保留 `import ... from 'hls.js'`。
 * E2E 通过 importmap 把它指到这里，避免联网拉真实 CDN（也避免 CDN 抖动导致 flaky）。
 *
 * 注意：E2E 全程注入 MockKernel，**不会实例化 HlsKernel**，
 * 因此这个桩只需要满足「可被静态 import」——形状对即可，行为不会被调用。
 * 如果将来要测真实 HlsKernel 分支，应在此实现更完整的替身，或改用真实 hls.js。
 */
export default class Hls {
  static isSupported() {
    return false
  }
  static get Events() {
    return {}
  }
  static get ErrorTypes() {
    return {}
  }
  constructor() {
    throw new Error('hls-stub: E2E 应注入 MockKernel，不应实例化 HlsKernel')
  }
}
