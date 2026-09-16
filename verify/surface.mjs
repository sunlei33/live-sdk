/**
 * 公开面活性普查（public surface liveness census）
 *
 * ── 为什么需要它 ──
 *
 * `verify/exports.mjs` 保证公开面的**名字**没变，但不问这些名字**还有没有用**。
 * 于是会出现这样的东西：导出了、能 import、文档里也列着，但 SDK 内部从不调用、
 * 测试也从不碰 —— 它看起来像一项能力，其实是**已经死掉的残留**。
 *
 * 实测：`sniffer` 曾有 5 个这样的函数（`isIOS` / `isSafari` / `isAndroid` /
 * `supportsH264` / `canAutoplay`，占该文件 51%），一路活到 0.5.0 才被人工发现。
 * 它们不是「忘了用」，而是**被设计取代**：全仓平台差异早已改为能力判定，
 * UA 嗅探函数留着只会诱导后人写回平台分支。
 *
 * 本脚本把「零消费者的公开导出」转成构建失败；确属「仅供接入方使用」的，
 * 必须显式登记进 `INTENTIONAL_PUBLIC_API` 并写明理由 ——
 * 让「对外保留」成为一次**有意识的决定**，而不是一次遗忘。
 * （与 `events.mjs` 的 `INTENTIONALLY_SILENT` 同思路。）
 *
 * ── 判据 ──
 *
 * 对每个公开名字，统计两个方向：
 * - **内部消费者**：`src/` 中出现次数（含声明处）；
 * - **被验证覆盖**：`test/` 与 `verify/` 中出现次数（**排除本清单与 exports.mjs**，
 *   否则清单自身就会把每一项都「覆盖」掉，判据立刻失效）。
 *
 * 当 `src/` 出现次数 <= 1（即只有声明、无人调用）**且** 验证侧为 0 时 → 判为可疑。
 * 可疑项必须在 `INTENTIONAL_PUBLIC_API` 里，否则失败。
 *
 * ── 它证明了什么、没证明什么（勿过度解读）──
 *
 * 证明：**存在**消费者或覆盖。这正是「死导出」的判据 —— 两者皆无必然是死的。
 * 未证明：
 * 1. 消费者**可达** —— 只在 `if (false)` 里被调用的函数仍会判 OK；也不区分调用一次与一万次。
 *    可达性与强度由单测/冒烟/E2E 覆盖，四者互补。
 * 2. **新出现的**死导出 —— 本脚本只审「清单里登记过的名字」（遍历的是 `public-surface.mjs`），
 *    尚未登记的新导出会被直接跳过。**这一环由 `exports.mjs` 补上**：它做精确集合比对，
 *    未登记的新导出会被判「多余」而失败。因此两者必须成对使用 ——
 *    exports 负责把新导出「逼」进清单，surface 负责审清单里每一项的活性。
 * 3. 判据是**文本匹配**，对名字独特的导出最有效（死代码的典型特征）；
 *    `kind: 'member'` 只认 `.name` 成员访问，避免 `on`/`off` 这类常用词被误算。
 *
 * ── 自测记录（2026-09-16）──
 *
 * - 往清单里登记一个无消费者的名字（`__selfTestDeadProbe`）→ 正确报 `SUSPECT` 并以退出码 1 失败；
 *   撤回后恢复全绿。
 * - 反向验证过判据的关键细节：早先按「文件名以 index.ts 结尾」判定 barrel，
 *   把装着 `UIMount` 实现的 `src/ui/index.ts` 一并排除，导致 `onDestroy`（真实有调用）被误报为死代码。
 *   现改为按内容判定「纯再导出」。
 *
 * 退出码非 0 即失败（已接入 `npm run verify`）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GROUPS } from './public-surface.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

/**
 * 确属「仅供接入方使用、SDK 内部不调用、也暂无测试」的公开项。
 * **登记即承诺这项 API 是有意对外的**，因此每条都要写清「谁在用、为什么内部不用」。
 *
 * 当前为**空**：收紧判据（去掉声明处与 barrel、类方法改按成员访问统计）之后，
 * 119 个公开名字全部有消费者或覆盖，无需豁免。
 * 空表本身就是好消息 —— 说明没有「靠豁免兜着的幽灵 API」。
 *
 * 登记格式：
 *   name: '理由（谁在用 / 为什么 SDK 内部不调用它）',
 */
const INTENTIONAL_PUBLIC_API = {
  // 例：someExport: '接入方在自定义 XXX 时使用；SDK 内部走 YYY，不需要它',
}

const FILES = { src: [], test: [], verify: [] }
for (const group of Object.keys(FILES)) {
  const dir = join(ROOT, group)
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      if (n === 'node_modules') continue
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|mjs|js)$/.test(n) && !n.endsWith('.d.ts')) FILES[group].push(p)
    }
  }
  walk(dir)
}

/** 普查自身与形状清单不参与统计（否则每一项都会被「登记」本身凑成已覆盖） */
const EXCLUDE_IN_VERIFY = new Set([join(HERE, 'public-surface.mjs'), join(HERE, 'exports.mjs'), join(HERE, 'surface.mjs')])
FILES.verify = FILES.verify.filter((f) => !EXCLUDE_IN_VERIFY.has(f))

const contents = new Map()
for (const list of Object.values(FILES)) {
  for (const f of list) if (!contents.has(f)) contents.set(f, readFileSync(f, 'utf8'))
}

/**
 * 按词边界统计出现次数。
 * `kind==='member'` 时只认成员访问（`.name`），避免 `on` / `off` / `emit` 这类常用词
 * 被注释与其他对象的同名方法误算成「有消费者」。
 */
function countIn(files, name, kind) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(kind === 'member' ? `\\.${esc}\\b` : `\\b${esc}\\b`, 'g')
  let n = 0
  for (const f of files) {
    const m = contents.get(f)?.match(re)
    if (m) n += m.length
  }
  return n
}

/**
 * 找出「声明该名字」的源文件。**必须排除它**，否则声明本身会被算成一个消费者 ——
 * 那样每个导出都至少得 1 分，判据直接失效。
 */
function declaringFiles(name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(
    `export\\s+(?:async\\s+)?(?:abstract\\s+)?(?:default\\s+)?(?:function|class|const|let|var|enum|interface|type)\\s+${esc}\\b`,
  )
  return FILES.src.filter((f) => re.test(contents.get(f)))
}

/**
 * 判断是否为**纯再导出**文件（barrel）。
 *
 * barrel 只做转出口、不构成「有人用」，必须排除 —— 否则每个被 barreled 的导出都白得 1 分。
 * 但**不能按文件名 `index.ts` 一刀切**：`src/ui/index.ts` 里就装着 `UIMount` 的实现，
 * 一刀切会把它里的真实调用（`this.player.onDestroy(...)`）也排除掉，
 * 造成「明明有人用却判成死代码」的假阳性（实测踩过）。
 *
 * 因此按内容判定：剔除 import / export 语句与注释后**剩余可执行语句为 0**，才算纯 barrel。
 */
function isPureBarrel(file) {
  const lines = (contents.get(file) || '').split(/\r?\n/)
  let code = 0
  let inComment = false
  let inExportBlock = false
  for (const raw of lines) {
    const t = raw.trim()
    if (inComment) {
      if (t.includes('*/')) inComment = false
      continue
    }
    if (!t) continue
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inComment = true
      continue
    }
    if (t.startsWith('//')) continue
    if (inExportBlock) {
      if (t.includes('}')) inExportBlock = false
      continue
    }
    if (/^import\b/.test(t)) continue
    if (/^export\s+(?:type\s+)?\{/.test(t)) {
      if (!t.includes('}')) inExportBlock = true
      continue
    }
    if (/^export\s+\*/.test(t)) continue // export * as ns from / export * from
    code++
  }
  return code === 0
}

const BARRELS = new Set(FILES.src.filter(isPureBarrel))

let fail = 0
let checked = 0
let exemptUsed = 0
const suspects = []

for (const { label, names, kind } of GROUPS) {
  console.log(`\n=== ${label}（${names.length}）===`)
  for (const name of names) {
    checked++
    // 消费者 = src 中「除去声明处与 barrel」的出现次数
    const own = kind === 'member' ? [] : declaringFiles(name)
    const consumers = FILES.src.filter((f) => !BARRELS.has(f) && !own.includes(f))
    const inSrc = countIn(consumers, name, kind)
    const inVerified = countIn(FILES.test, name, kind) + countIn(FILES.verify, name, kind)

    const alive = inSrc > 0 || inVerified > 0
    const exempt = Object.prototype.hasOwnProperty.call(INTENTIONAL_PUBLIC_API, name)
    if (alive) {
      console.log(`  OK        ${name.padEnd(34)} 消费者 ${String(inSrc).padStart(3)}  验证 ${inVerified}`)
    } else if (exempt) {
      exemptUsed++
      console.log(`  豁免      ${name.padEnd(34)} 消费者 0  验证 0`)
    } else {
      fail++
      suspects.push(name)
      console.log(`  SUSPECT   ${name.padEnd(34)} 消费者 0  验证 0  ← 零消费者且无覆盖`)
    }
  }
}

console.log(`\n共 ${checked} 个公开名字；豁免 ${exemptUsed} 个；可疑 ${suspects.length} 个`)
if (suspects.length) {
  console.log('\n可疑项（要么删掉，要么登记进 INTENTIONAL_PUBLIC_API 并写明理由）：')
  for (const s of suspects) console.log(`  - ${s}`)
}
console.log(fail === 0 ? '\nSURFACE CENSUS OK' : `\n${fail} SUSPECT`)
process.exit(fail === 0 ? 0 : 1)
