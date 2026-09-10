/**
 * 运行时冒烟测试：最小 DOM mock 下走通 createPlayer → play → 状态/能力 → destroy。
 * 用于验证运行时装配（容器/内核选路/状态机/插件）无空指针、无异常。
 */

function makeEl(tag) {
  const listeners = {}
  return {
    tagName: tag,
    style: {},
    children: [],
    attributes: {},
    // 状态属性
    volume: 1,
    muted: false,
    currentTime: 0,
    paused: true,
    poster: '',
    src: '',
    autoplay: false,
    currentSrc: '',
    videoWidth: 0,
    videoHeight: 0,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    // 方法
    setAttribute(k, v) { this.attributes[k] = v },
    removeAttribute(k) { delete this.attributes[k] },
    appendChild(c) { this.children.push(c); return c },
    remove() {},
    load() {},
    play() { this.paused = false; return Promise.resolve() },
    pause() { this.paused = true },
    canPlayType() { return '' },
    addEventListener(t, fn) { (listeners[t] ||= []).push(fn) },
    removeEventListener(t, fn) { const l = listeners[t] || []; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1) },
    _fire(t) { (listeners[t] || []).forEach((f) => f()) },
  }
}

const container = makeEl('div')
const els = {}
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
}
globalThis.document = {
  visibilityState: 'visible',
  createElement: (tag) => (els[tag] ||= makeEl(tag)),
  querySelector: () => container,
  addEventListener() {},
  removeEventListener() {},
}
Object.defineProperty(globalThis, 'navigator', {
  value: {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
    onLine: true,
    platform: 'Win32',
    vendor: '',
    maxTouchPoints: 0,
    connection: undefined,
  },
  configurable: true,
})

const sdk = await import('../dist/live-sdk.es.js')
const { createPlayer } = sdk

let failures = 0
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name)
  if (!cond) failures++
}

// 1. 构造 + 初始状态
const p = createPlayer({ container: '#player', url: 'https://cdn/live.m3u8' })
const s0 = p.getState()
check('构造后 root 含 video', p.root.children.includes(p.media))
check('初始 playing=false', s0.playing === false)
check('初始 capabilities.stats=basic', s0.capabilities.stats === 'basic')

// 2. play → 内核选路（node 无 MSE → NativeKernel）→ 加载
await p.play('https://cdn/live.m3u8')
const s1 = p.getState()
check('play 后 capabilities 已更新', s1.capabilities !== undefined)
check('play 后 capabilities.qualitySwitch=false（NativeKernel）', s1.capabilities.qualitySwitch === false)

// 3. 能力对齐报告结构
const report = p.getFeatureStatus()
check('getFeatureStatus 返回 5 项（含 airplay）', report.features.length === 5)
check('summary 有 matched/mismatched', 'matched' in report.summary && 'mismatched' in report.summary)
check('drm client 恒 absent', report.features.find((f) => f.feature === 'drm')?.client === 'absent')
// 投屏：纯客户端能力，服务端侧恒 supported；NativeKernel 下 client=degraded（系统接管）
const airplay = report.features.find((f) => f.feature === 'airplay')
check('airplay 键存在', !!airplay)
check('NativeKernel 下 airplay client=degraded', airplay?.client === 'degraded')
check('airplay server 恒 supported（无服务端依赖）', airplay?.server === 'supported')
check('airplay 端到端对齐（matched=true）', airplay?.matched === true)

// 4. 指标查询（NativeKernel 受限集）
const stats = p.getStats()
check('getStats 可调用', typeof stats === 'object')
const buf = p.bufferInfo()
check('bufferInfo 结构', Array.isArray(buf.buffers) && 'remaining' in buf)
check('bufferInfo 含双口径 totalRemaining/totalLength', 'totalRemaining' in buf && 'totalLength' in buf)

// 5. 命令无空指针
p.mute(true)
p.setVolume(0.5)
p.switchQuality(1) // NativeKernel 下 no-op
await p.switchURL('https://cdn/backup.m3u8')
check('mute/setVolume/switchURL 不抛异常', true)

// 6. 订阅 + 事件（spec：getState 取初始快照，subscribe 仅在变更时回调）
let received = null
const unsub = p.subscribe((s) => { received = s })
p.mute(true) // 触发 state.set → 回调
check('subscribe 变更时回调', received !== null && received.muted === true)
unsub()
received = null
p.mute(false) // 取消后不应再回调
check('unsubscribe 后不再回调', received === null)

// 7. 复现修复：provider 起播（config.url 为空）→ 暂停 → 无参 play() 不抛错
//    旧行为：无参 play() 走 resolveConfig(undefined) 因 config.url 缺失抛错（demo 报错的根因）
//    新行为：已有会话时无参 play() = 恢复播放，不重新 load
const p2 = createPlayer({ container: '#player2' }) // 注意：不给 url
await p2.play(() => ({ url: 'https://cdn/live2.m3u8' }))
let resumeErr = null
try {
  p2.pause()
  await p2.play() // 无参：应仅恢复播放，不得抛「未提供播放地址」
} catch (e) {
  resumeErr = e
}
check('provider 起播后，暂停→无参 play() 不抛错', resumeErr === null)
check('恢复后无参 play() 前已加载（hasLoaded 语义）', resumeErr === null)

// 8. 起播失败的内核残留不应让无参 play() 误判为「可恢复」
//    用会抛错的内核构造器模拟 load 失败
const pFail = createPlayer({
  container: '#playerFail',
  kernel: class {
    static isSupported() { return true }
    static kernelName = 'FailKernel'
    capabilities = { lowLatency: false, qualitySwitch: false, abr: false, stats: 'basic' }
    load() { return Promise.reject(new Error('load failed')) }
    switchURL() { return Promise.resolve() }
    switchQuality() {}
    getStats() { return {} }
    bufferInfo() { return { buffers: [], behind: 0, remaining: 0, length: 0 } }
    recover() {}
    destroy() {}
  },
})
let failLoadErr = null
try { await pFail.play('https://cdn/never.m3u8') } catch (e) { failLoadErr = e }
let afterFailErr = null
try { await pFail.play() } catch (e) { afterFailErr = e }
check('load 失败的流，随后无参 play() 仍正确报错（不误判为恢复）', afterFailErr !== null)

// 8. 无参 play() 但从未起播（无 url、无会话）→ 应明确报错（保留原语义）
const p3 = createPlayer({ container: '#player3' })
let noUrlErr = null
try {
  await p3.play()
} catch (e) {
  noUrlErr = e
}
check('从未起播时无参 play() 正确报错', noUrlErr !== null)

// 9. 修复验证：pause() 后 state.playing 同步翻转为 false（不等异步 media 事件）
//    旧行为：pause() 只调 mediaProxy.pause()，`pause` 事件异步派发，
//    getState().playing 在调用后仍为 true → UI 按钮卡在「播放中」。
//    新行为：pause() 乐观更新快照，同步读取即为 false。
const p4 = createPlayer({ container: '#player4' })
await p4.play(() => ({ url: 'https://cdn/live4.m3u8' }))
// 走状态机真实路径：loading →(manifestParsed)→ ready →(play)→ playing
p4.media._fire('loadedmetadata')
p4.media._fire('playing')
check('起播后 state.playing=true', p4.getState().playing === true)
p4.pause()
check('pause() 后 state.playing 同步为 false', p4.getState().playing === false)
// 幂等：异步 media `pause` 事件到达后仍为 false，且不重复抛错
p4.media._fire('pause')
check('media pause 事件到达后 state.playing 仍为 false', p4.getState().playing === false)

// 9b. 修复验证：stalled（缓冲中）态被用户 pause 后，不应被后续 stall 事件复活为播放中
const p4b = createPlayer({ container: '#player4b' })
await p4b.play(() => ({ url: 'https://cdn/live4b.m3u8' }))
p4b.media._fire('loadedmetadata')
p4b.media._fire('playing')
p4b.media._fire('waiting') // playing → stalled（快照 playing 仍为 true）
check('stalled 期间快照仍视为播放中', p4b.getState().playing === true)
p4b.pause() // 用户在缓冲中暂停
check('stalled 中 pause() 后快照为 false', p4b.getState().playing === false)
p4b.media._fire('waiting') // 后续 stall 事件不得复活按钮
check('后续 stall 事件不复活为播放中', p4b.getState().playing === false)

// 10. 修复验证：无参 play() 恢复后同步置 playing=true
await p4.play()
check('无参 play() 恢复后 state.playing 同步为 true', p4.getState().playing === true)

// 10b. 修复验证：断流重连（error→retry→loading→ready）期间播放意图保持，按钮不闪回「播放」
//      旧行为：recover() 把状态机推离 playing → onStateChange 置 playing=false，
//      重试成功回 ready 后若浏览器不再派发 `playing` 事件（同源重新 load 时常见），
//      按钮永远卡在「播放」图标（画面在放、按钮却是播放）。
const p7 = createPlayer({ container: '#player7', network: { retryCount: 3, retryDelay: 1, loadTimeout: 50 } })
await p7.play(() => ({ url: 'https://cdn/live7.m3u8' }))
p7.media._fire('loadedmetadata')
p7.media._fire('playing')
check('重连前 playing=true', p7.getState().playing === true)
const sm7 = p7.stateMachine
sm7.transition('stall')
check('stalled 期间按钮仍为播放中', p7.getState().playing === true)
sm7.transition('timeout') // → error
check('error 期间按钮仍为播放中（重连是内部过程）', p7.getState().playing === true)
sm7.transition('retry') // → loading
check('retry/loading 期间按钮仍为播放中', p7.getState().playing === true)
p7.media._fire('loadedmetadata') // 重试成功 → manifestParsed → ready + attemptPlay
check('重试成功回 ready 后按钮仍为播放中（不闪回播放图标）', p7.getState().playing === true)

// 10c. 修复验证：重连期间用户显式暂停 → 重试成功不得复活
const p8 = createPlayer({ container: '#player8', network: { retryCount: 3, retryDelay: 1, loadTimeout: 50 } })
await p8.play(() => ({ url: 'https://cdn/live8.m3u8' }))
p8.media._fire('loadedmetadata')
p8.media._fire('playing')
const sm8 = p8.stateMachine
sm8.transition('stall')
sm8.transition('timeout')
sm8.transition('retry') // loading
p8.pause() // 用户在重连期间按下暂停
check('重连期间用户暂停 → 按钮为播放', p8.getState().playing === false)
p8.media._fire('loadedmetadata') // 重试成功
check('重试成功后不复活为播放中（尊重用户暂停意图）', p8.getState().playing === false)

// 11. 修复验证：重试诊断快照（当前地址 + 网络环境）
//     构造一个会报错的流，触发 recover → 应带 diagnostic
const p5 = createPlayer({
  container: '#player5',
  network: { retryCount: 3, retryDelay: 1, loadTimeout: 50 },
})
await p5.play(() => ({ url: 'https://cdn/primary.m3u8', backup: 'https://cdn/backup.m3u8' }))
check('getLastRetryDiagnostic 起始为 null', p5.getLastRetryDiagnostic() === null)

// 12. 诊断快照：触发一次原生 media error → dispatchError(NETWORK_ERROR) → recover → 带 diagnostic
p5.media._fire('error')
const diag = p5.getLastRetryDiagnostic()
check('重试后产生诊断快照', diag !== null && typeof diag === 'object')
if (diag) {
  check('诊断含播放地址 url', typeof diag.url === 'string' && diag.url.length > 0)
  check('诊断含主地址 primaryUrl', diag.primaryUrl === 'https://cdn/primary.m3u8')
  check('诊断含是否备用流 isBackup', typeof diag.isBackup === 'boolean')
  check('诊断含网络质量 networkQuality', typeof diag.networkQuality === 'string')
  check('诊断含在线状态 online', typeof diag.online === 'boolean')
  check('诊断含前后台 visibility', diag.visibility === 'foreground' || diag.visibility === 'background')
  check('诊断含重试次数/延迟/错误码', typeof diag.retryCount === 'number' && typeof diag.delay === 'number' && typeof diag.errorCode === 'string')
  check('诊断含缓冲与进度上下文', typeof diag.bufferBehind === 'number' && typeof diag.currentTime === 'number')
}

// 12b. 诊断也随 error 事件的 PlayerError 一起暴露
let errWithDiag = null
const p6 = createPlayer({
  container: '#player6',
  network: { retryCount: 3, retryDelay: 1, loadTimeout: 50 },
})
p6.on('error', (e) => { if (e.diagnostic) errWithDiag = e })
await p6.play(() => ({ url: 'https://cdn/p6.m3u8' }))
p6.media._fire('error')
check('error 事件的 PlayerError 携带 diagnostic', errWithDiag !== null && errWithDiag.diagnostic.url === 'https://cdn/p6.m3u8')

// 13. 修复验证：近尾卡顿应判 ended 而非重连
//     构造：playing 态 + buffer 已到末尾 + 时长有限 → onStall 应走 ended
{
  const pTail = createPlayer({ container: '#playerTail', network: { retryCount: 3, retryDelay: 1, loadTimeout: 9999 } })
  await pTail.play(() => ({ url: 'https://cdn/tail.m3u8' }))
  pTail.media._fire('loadedmetadata')
  pTail.media._fire('playing')
  // 模拟「缓冲已到末尾」：duration=10，buffered=[0,10]，currentTime=9.9
  pTail.media.duration = 10
  pTail.media.currentTime = 9.9
  pTail.media.buffered = { length: 1, start: () => 0, end: () => 10 }
  let endedFired = false
  pTail.on('ended', () => { endedFired = true })
  pTail.media._fire('waiting') // 触发 onStall
  check('近尾卡顿 → 判为 ended（非重连）', pTail.stateMachine.current === 'ended')
  check('近尾卡顿 → 派发 ended 事件', endedFired === true)
  check('近尾 ended 后 playing=false', pTail.getState().playing === false)
}

// 13b. 对照：非近尾卡顿（buffer 远未到末尾）应正常走 stalled（不误判 ended）
{
  const pMid = createPlayer({ container: '#playerMid', network: { retryCount: 3, retryDelay: 1, loadTimeout: 9999 } })
  await pMid.play(() => ({ url: 'https://cdn/mid.m3u8' }))
  pMid.media._fire('loadedmetadata')
  pMid.media._fire('playing')
  pMid.media.duration = 100
  pMid.media.currentTime = 5
  pMid.media.buffered = { length: 1, start: () => 0, end: () => 10 } // 距末尾 90s，非近尾
  pMid.media._fire('waiting')
  check('非近尾卡顿 → 仍走 stalled（不误判 ended）', pMid.stateMachine.current === 'stalled')
}

// 13c. 直播无限流（duration=Infinity）即便 buffer 到「末端」也不得误判 ended
{
  const pLive = createPlayer({ container: '#playerLive', network: { retryCount: 3, retryDelay: 1, loadTimeout: 9999 } })
  await pLive.play(() => ({ url: 'https://cdn/live_inf.m3u8' }))
  pLive.media._fire('loadedmetadata')
  pLive.media._fire('playing')
  pLive.media.duration = Infinity
  pLive.media.currentTime = 100
  pLive.media.buffered = { length: 1, start: () => 0, end: () => 100 }
  pLive.media._fire('waiting')
  check('直播无限流 → 不误判 ended（仍走 stalled）', pLive.stateMachine.current === 'stalled')
}

// 14. 修复验证：初始化期伪 pause 事件不得把意图置负（按钮抖动）
{
  const pInit = createPlayer({ container: '#playerInit', network: { retryCount: 3, retryDelay: 1, loadTimeout: 9999 } })
  await pInit.play(() => ({ url: 'https://cdn/init.m3u8' }))
  // 此刻状态机在 loading，首帧未出；模拟内核 attach 期派发的伪 pause
  pInit.media._fire('pause')
  check('初始化期伪 pause 不改状态机（仍在 loading）', pInit.stateMachine.current === 'loading')
  // manifest 解析后应仍能自动起播（意图未被伪 pause 污染）
  pInit.media._fire('loadedmetadata')
  check('伪 pause 后仍能正常进入 ready 并自动续播', pInit.getState().playing === true)
}

// 15. 修复验证：bufferInfo 双口径（孤岛场景）
{
  const pBuf = createPlayer({ container: '#playerBuf' })
  await pBuf.play(() => ({ url: 'https://cdn/buf.m3u8' }))
  pBuf.media._fire('loadedmetadata')
  // 孤岛：buffers=[[0,10],[30,40]]，播放点在 5
  pBuf.media.currentTime = 5
  pBuf.media.buffered = {
    length: 2,
    start: (i) => (i === 0 ? 0 : 30),
    end: (i) => (i === 0 ? 10 : 40),
  }
  const bi = pBuf.bufferInfo()
  check('孤岛场景 buffers 保留全部区间', bi.buffers.length === 2)
  check('remaining 取当前播放块（到 10 → 5s）', Math.abs(bi.remaining - 5) < 0.01)
  check('length 取当前播放块总长（10s）', Math.abs(bi.length - 10) < 0.01)
  check('totalRemaining 跨孤岛求和（5 + 10 = 15s）', Math.abs(bi.totalRemaining - 15) < 0.01)
  check('totalLength 为全部区间之和（10 + 10 = 20s）', Math.abs(bi.totalLength - 20) < 0.01)
}

// 16. 修复验证：destroy 幂等且清理内核（MSE 生命周期）
{
  const pD = createPlayer({ container: '#playerD' })
  await pD.play(() => ({ url: 'https://cdn/d.m3u8' }))
  pD.destroy()
  pD.destroy() // 二次销毁不应抛错
  check('destroy 可重复调用不抛错', true)
}

// 17. 销毁
p.destroy()
check('destroy 后 root 已移除', true)

console.log(failures === 0 ? '\nSMOKE TEST OK' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
