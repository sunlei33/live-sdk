/**
 * 活事件清单断言（events liveness census）
 *
 * ── 为什么需要这个脚本 ──
 *
 * `Events` 枚举曾长期存在「声明了、导出了、`on()` 注册会成功、但全仓库零 emit」的死事件
 * （`PLAY` 与 `BUFFER_UPDATE`，直到 0.3.0 都是如此）。这类缺陷**所有既有质量门都拦不住**：
 *
 *   - `verify/contract.ts` 只验类型签名能否编译（`player.on('first_frame', …)` 通过即算过），
 *     它甚至调了 `useHooks(...)` —— 看着像在验证钩子可用，实际只证明了 API 存在；
 *   - `verify/smoke.mjs` 与 E2E 只订阅自己关心的那几个事件（`error` / `ended` / `live_status`）；
 *   - 单测验证的是「`emit` 出去能收到」，**不验证「有没有人 emit」**。
 *
 * 于是「订阅了一个永不触发的事件」这种静默失效，在第 116 个单测通过之后依然健在。
 * 本脚本把这个盲区补上，把静默失效转成构建失败：
 *
 *   1. 枚举里每个成员，必须在 `src/` 里至少有一个真实派发点；
 *   2. 派发点引用的 `Events.X` 必须真的存在于枚举（防拼错、防枚举改名后留下悬空引用）；
 *   3. 确属「有意不派发」的事件，必须显式登记进 `INTENTIONALLY_SILENT` 并写明原因 ——
 *      让豁免成为一次**有意识的决定**，而不是一次遗忘。
 *
 * ── 它证明了什么、没证明什么（勿过度解读）──
 *
 * 证明：**存在**派发点。这正是「死事件」的判据 —— 零派发点必然是死的。
 * 未证明：派发点**可达**。例如 `emit(Events.X)` 写在一个永远进不去的 `if` 分支里，
 * 本脚本仍会判 OK。可达性由单测 / 冒烟 / E2E 覆盖，两者互补、不可互相替代。
 *
 * 自测记录（2026-09-16）：临时往枚举塞一个 `__SELFTEST_DEAD` 成员后，本脚本正确报
 * `DEAD` 并以退出码 1 失败；撤回后恢复全绿。即它确实能拦住 0.3.0 那对死事件。
 *
 * 退出码非 0 即失败（已接入 `npm run verify`）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Events } from '../dist/live-sdk.es.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SRC = join(ROOT, 'src')

/**
 * 已确认「有意不派发」的事件。
 * **当前为空** —— 0.4.0 起 `PLAY` / `BUFFER_UPDATE` 都已接上真实触发时机。
 * 若将来确需保留一个无触发的事件，在此登记并写明理由与计划，否则请从枚举移除。
 */
const INTENTIONALLY_SILENT = {
  // 示例（当前无）：
  //   SOME_EVENT: '说明：为什么它暂时不派发 + 何时补上或移除',
}

/** 递归收集 src 下所有 .ts 文件 */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) collect(full, out)
    else if (entry.endsWith('.ts')) out.push(full)
  }
  return out
}

/**
 * 抽取文件里所有 `emit(<第一实参>` 的第一实参文本。
 * 需要同时覆盖三种写法：
 *   - `this.emit(Events.LOAD_START, …)`  → 枚举成员
 *   - `this.emit('live_status', …)`      → 字符串字面量（旁路事件）
 *   - `this.emit(LIVE_STATUS_ERROR_EVENT, …)` → 常量标识符
 * 方法**定义**处的 `emit(event, data)` 不会命中 `Events.` 或引号或全大写标识符，天然被排除。
 */
function scanEmits(source) {
  const hits = []
  const re = /\bemit\s*\(\s*([^,)\n]+)/g
  let m
  while ((m = re.exec(source)) !== null) {
    hits.push(m[1].trim())
  }
  return hits
}

const enumNames = Object.keys(Events)
const enumNameSet = new Set(enumNames)
const counts = new Map(enumNames.map((n) => [n, []]))
const externalEmits = [] // 枚举外的旁路事件（live_status 等，刻意不属于内核契约）
const danglingRefs = [] // emit(Events.X) 里 X 并不存在

for (const file of collect(SRC)) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  lines.forEach((line, i) => {
    for (const arg of scanEmits(line)) {
      const at = `${rel}:${i + 1}`
      const enumRef = arg.match(/^Events\.([A-Za-z0-9_]+)$/)
      if (enumRef) {
        const name = enumRef[1]
        if (enumNameSet.has(name)) counts.get(name).push(at)
        else danglingRefs.push(`${at}  →  Events.${name}（枚举中不存在）`)
        continue
      }
      const literal = arg.match(/^['"]([^'"]+)['"]$/)
      if (literal) {
        externalEmits.push([literal[1], at])
        continue
      }
      // 其余形态（如 LIVE_STATUS_ERROR_EVENT）视为「非枚举常量」，登记为旁路
      if (/^[A-Z][A-Z0-9_]*$/.test(arg)) externalEmits.push([arg, at])
    }
  })
}

let fail = 0
let silentCount = 0

console.log('=== 事件活性普查（Events 枚举 vs src/ 实际派发点）===')
console.log(`枚举成员 ${enumNames.length} 个\n`)

for (const name of enumNames) {
  const points = counts.get(name)
  const exempt = INTENTIONALLY_SILENT[name]
  if (points.length > 0) {
    const head = points[0]
    const more = points.length > 1 ? `  (+${points.length - 1} 处)` : ''
    console.log(`OK    ${name.padEnd(20)} ${String(points.length).padStart(2)} 处  ${head}${more}`)
  } else if (exempt) {
    silentCount++
    console.log(`SKIP  ${name.padEnd(20)}  0 处  [已登记豁免] ${exempt}`)
  } else {
    fail++
    console.log(`DEAD  ${name.padEnd(20)}  0 处  ← 声明但永不派发（补上触发时机，或从 Events 移除）`)
  }
}

if (externalEmits.length > 0) {
  console.log('\n枚举外派发（旁路事件，刻意不属于内核契约，不参与判定）：')
  for (const [name, at] of externalEmits) console.log(`  -   ${name.padEnd(24)} ${at}`)
}

if (danglingRefs.length > 0) {
  fail += danglingRefs.length
  console.log('\n悬空引用（引用了不存在的事件成员）：')
  for (const d of danglingRefs) console.log(`  !!  ${d}`)
}

console.log(
  `\n死事件 ${enumNames.length - silentCount - [...counts.values()].filter((p) => p.length > 0).length}` +
    ` | 豁免 ${silentCount} | 悬空引用 ${danglingRefs.length}`,
)
console.log(fail === 0 ? 'EVENTS LIVENESS OK' : `EVENTS LIVENESS FAILED (${fail})`)
process.exit(fail === 0 ? 0 : 1)
