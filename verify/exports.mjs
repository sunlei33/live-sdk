import * as sdk from '../dist/live-sdk.es.js'
import * as ui from '../dist/live-sdk-ui.es.js'
import * as react from '../dist/live-sdk-react.es.js'
import * as vue from '../dist/live-sdk-vue.es.js'

const core = ['createPlayer','Player','BasePlugin','UIMount','HlsKernel','NativeKernel','WebEnvAdapter','ConsoleReporter','SentryReporter','LivePolling','LIVE_STATUS_ERROR_EVENT','Events','ERROR_CODE','deepMerge','sniffer','logger']
const uiExports = ['mountDefaultUI','UIMount','PlayButton','MuteButton','QualityPanel','FullscreenButton','UIPlugin']
const reactExports = ['usePlayer']
const vueExports = ['usePlayer']

let fail = 0
console.log('=== core (live-sdk) ===')
for (const k of core) { const ok = k in sdk; if (!ok) fail++; console.log((ok?'OK  ':'MISS')+'  '+k) }
console.log('=== ui (live-sdk/ui) ===')
for (const k of uiExports) { const ok = k in ui; if (!ok) fail++; console.log((ok?'OK  ':'MISS')+'  '+k) }
console.log('=== react (live-sdk/react) ===')
for (const k of reactExports) { const ok = k in react; if (!ok) fail++; console.log((ok?'OK  ':'MISS')+'  '+k) }
console.log('=== vue (live-sdk/vue) ===')
for (const k of vueExports) { const ok = k in vue; if (!ok) fail++; console.log((ok?'OK  ':'MISS')+'  '+k) }

// 验证 Events 枚举值与 spec-summary 一致（值即小写 snake_case）
const ev = sdk.Events
const evCheck = ev.FIRST_FRAME === 'first_frame' && ev.FEATURES_UPDATED === 'features_updated' && ev.MANIFEST_PARSED === 'manifest_parsed'
console.log('=== Events 值域 ===', evCheck ? 'OK' : 'FAIL')
if (!evCheck) fail++

// 轮询失败事件是**独立命名**（刻意不进 Events 枚举，避免与播放错误通道混流）
const errEvCheck = sdk.LIVE_STATUS_ERROR_EVENT === 'live_status_error'
console.log('=== live_status_error 事件名 ===', errEvCheck ? 'OK' : 'FAIL')
if (!errEvCheck) fail++

console.log(fail === 0 ? '\nALL EXPORTS OK' : `\n${fail} MISSING`)
process.exit(fail === 0 ? 0 : 1)
