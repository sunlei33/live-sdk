/**
 * 公开面形状断言（exact-set）
 *
 * ── 为什么从 `k in sdk` 改成「精确集合比对」──
 *
 * 原实现只问「这个名字在不在 `sdk` 上」，于是**成员级的漂移完全不被拦住**：
 * 命名空间成员（如当时的 `sniffer.xxx`）、枚举成员、常量内容被删除或改名都不会失败。
 * 实测后果：`sniffer` 有 5 个函数（isIOS / isSafari / isAndroid / supportsH264 / canAutoplay）
 * 零引用、零测试、却一路活到 0.6.0 —— 因为没有任何一道门会看它们一眼；
 * 而 `bindPress` / `VolumeControl` 这两项**确实对外**的导出，则连清单里都没有。
 *
 * （该命名空间本身已在 0.6.0 之后整体移除 —— 它整个模块都是 Web 平台实现，
 * 媒体设备能力上移到 `MediaSurface.canPlay()`，宿主能力归 `platform/web/capabilities`。）
 *
 * 现在**缺失与多余都算失败**：任何公开面变化都必须显式更新 `public-surface.mjs`。
 * 这是刻意的 —— 公开面属于契约，改动应当是一次**有意识的决定**
 * （同 `events.mjs` 的 `INTENTIONALLY_SILENT` 豁免表思路）。
 *
 * ── 覆盖面与「为什么 Player 只做单向校验」──
 *
 * | 对象 | 校验方式 | 理由 |
 * |---|---|---|
 * | 顶层导出 / 命名空间成员 / 枚举成员 / 常量内容 | **精确集合（双向）** | 全部是公开面，无内部实现混入 |
 * | `Player.prototype` | **只校验「必须存在」** | 原型上同时挂着 ~60 个内部方法，其中绝大多数是 **私有**（TS 的 `private` 只在编译期，运行时仍是原型方法）。若做双向比对，任何内部重构都会误报 —— 那是把门装反了。故只保证公开契约不丢。 |
 *
 * ── 与 surface.mjs 的分工（两者必须成对使用）──
 *
 * 本脚本管**形状**：名字集合与清单一致（含把未登记的新导出「逼」进清单）。
 * `surface.mjs` 管**活性**：清单里每个名字在 src 里有没有消费者、有没有测试覆盖。
 * 单用任一个都有盲区：只用本脚本，5 个死函数当年照样全绿；
 * 只用 surface，新导出还没登记就会被跳过。
 *
 * ── 它证明了什么、没证明什么 ──
 *
 * 证明：公开面的**名字集合**与预期一致（无静默增删改名）。
 * 未证明：这些名字背后的**行为**是否正确 —— 那由 `verify/contract.ts`（编译期类型面）、
 * `verify/smoke.mjs`（运行时装配）、单测与 E2E 覆盖，四者互补。
 *
 * 自测记录（2026-09-16）：从 `src/ui/index.ts` 静默去掉 `VolumeControl` 的导出后，
 * 本脚本报 `缺失：VolumeControl` 并以退出码 1 失败；还原后恢复全绿。
 *
 * 退出码非 0 即失败（已接入 `npm run verify`）。
 */
import * as sdk from '../dist/live-sdk.es.js'
import * as ui from '../dist/live-sdk-ui.es.js'
import * as react from '../dist/live-sdk-react.es.js'
import * as vue from '../dist/live-sdk-vue.es.js'
import {
  CORE,
  UI,
  EVENTS,
  ERROR_CODE,
  ERROR_DOMAIN,
  COMMAND_NAMES,
  BUFFER_THRESHOLDS,
  PLAYER_PUBLIC,
} from './public-surface.mjs'

let fail = 0

/** 精确集合比对：缺失与多余都报失败 */
function exactSet(label, actual, expected) {
  const a = new Set(actual)
  const e = new Set(expected)
  const missing = [...e].filter((k) => !a.has(k)).sort()
  const extra = [...a].filter((k) => !e.has(k)).sort()
  const ok = missing.length === 0 && extra.length === 0
  if (!ok) fail++
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}（${e.size} 项）`)
  if (missing.length) console.log(`        缺失：${missing.join(' ')}`)
  if (extra.length) console.log(`        多余：${extra.join(' ')}（新增导出请登记到 public-surface.mjs）`)
}

/** 必须存在（不禁止新增，见文件头说明） */
function mustContain(label, actual, required) {
  const a = new Set(actual)
  const missing = required.filter((k) => !a.has(k)).sort()
  const ok = missing.length === 0
  if (!ok) fail++
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}（要求 ${required.length} 项，实际 ${a.size} 项）`)
  if (missing.length) console.log(`        缺失：${missing.join(' ')}`)
}

// ───────────────────────────── 顶层导出 ─────────────────────────────

exactSet('core (live-sdk) 顶层导出', Object.keys(sdk), CORE)
exactSet('ui (live-sdk/ui) 顶层导出', Object.keys(ui), UI)
exactSet('react (live-sdk/react) 顶层导出', Object.keys(react), ['usePlayer'])
exactSet('vue (live-sdk/vue) 顶层导出', Object.keys(vue), ['usePlayer'])

// ───────────────────────────── 枚举与常量内容 ─────────────────────────────

exactSet('Events 枚举成员', Object.keys(sdk.Events), EVENTS)
exactSet('ERROR_CODE 成员', Object.keys(sdk.ERROR_CODE), ERROR_CODE)
exactSet('ERROR_DOMAIN 成员', Object.keys(sdk.ERROR_DOMAIN), ERROR_DOMAIN)
exactSet('COMMAND_NAMES 内容', [...sdk.COMMAND_NAMES], COMMAND_NAMES)
exactSet('BUFFER_LEVEL_THRESHOLDS 内容', [...sdk.BUFFER_LEVEL_THRESHOLDS], BUFFER_THRESHOLDS)

// ───────────────────────────── Player 公开契约 ─────────────────────────────

mustContain('Player 公开方法', Object.getOwnPropertyNames(sdk.Player.prototype), PLAYER_PUBLIC)

// ───────────────────────────── 值域断言 ─────────────────────────────

const ev = sdk.Events
const evCheck =
  ev.FIRST_FRAME === 'first_frame' && ev.FEATURES_UPDATED === 'features_updated' && ev.MANIFEST_PARSED === 'manifest_parsed'
console.log(`${evCheck ? 'OK  ' : 'FAIL'}  Events 值域（值即小写 snake_case）`)
if (!evCheck) fail++

// 轮询失败事件是**独立命名**（刻意不进 Events 枚举，避免与播放错误通道混流）
const errEvCheck = sdk.LIVE_STATUS_ERROR_EVENT === 'live_status_error'
console.log(`${errEvCheck ? 'OK  ' : 'FAIL'}  live_status_error 事件名`)
if (!errEvCheck) fail++

console.log(fail === 0 ? '\nALL EXPORTS OK' : `\n${fail} FAILED`)
process.exit(fail === 0 ? 0 : 1)
