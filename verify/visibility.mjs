#!/usr/bin/env node
/**
 * 可见性门：`Player` 的**公开实例成员**必须与白名单一致 —— 多一个即失败。
 *
 * ── 为什么需要这道门 ──
 *
 * 其余八道门没有一道看得到「类成员的可见性」：
 * - `exports.mjs` 是**单向**校验「清单里的成员必须存在」→ 新增成员永不报错；
 * - `surface.mjs` 是按**导出名**做文本匹配的活性普查（清单来自 `public-surface.mjs`）
 *   → 它只看模块导出，不看类内成员。
 *
 * 实测漏网过一次：`Player` 里 `kernelReady = false` 忘了写 `private`。
 * 原因不是马虎 —— 它被兄弟类 `PluginManager` 跨类读取，而 TS 的 `private` 是**按类**封装的
 * （兄弟类也算外部），标了会编译失败，于是当时去掉修饰符换编译通过。后果：它进了
 * `dist/core/Player.d.ts`（`kernelReady: boolean;`，连 `readonly` 都没有），
 * 接入方一行 `player.kernelReady = true` 就能伪造「内核已就绪」。
 *
 * ── 判据（静态，用 TS 编译器 API 读 AST）──
 *
 * 1. **实例属性**：无 `private` / `protected` 修饰符的，必须登记在 `ALLOWED_PUBLIC_FIELDS`，
 *    且**必须是 `readonly`** —— 公开可写字段等于把内部状态的操作权交出去。
 * 2. **实例方法**：无修饰符的方法必须在 `public-surface.mjs#PLAYER_PUBLIC` 里 ——
 *    等价于「漏写 `private` 的私有方法」也会被拦下。
 * 3. 白名单自身**不得腐烂**：登记的名字若已不存在，也要清理，否则门会逐渐失去意义。
 *
 * ⚠️ 判据必须是**静态**的：`private` 在运行时会被擦除，反射
 * （`Object.getOwnPropertyNames(new Player(...))`）分不出 public 与 private。
 *
 * ── 自测记录（2026-09-23，实跑）──
 *
 * | 越界写法 | 结果 |
 * |---|---|
 * | 给某个 `private` 字段去掉修饰符 | FAIL ✓ |
 * | 去掉白名单字段（`root`）的 `readonly` | FAIL ✓ |
 * | 新增一个不在清单里的公开方法 | FAIL ✓ |
 * | 白名单里登记一个不存在的字段 | FAIL ✓（防腐烂） |
 * | 恢复原状 | VISIBILITY CHECK OK ✓ |
 *
 * 退出码非 0 即失败（已接入 `npm run verify`）。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { PLAYER_PUBLIC } from './public-surface.mjs'

// ⚠️ 从**目标仓库**（cwd）解析 typescript，而不是本脚本所在目录。
const require = createRequire(join(process.cwd(), 'noop.js'))
let ts
try {
  ts = require('typescript')
} catch {
  console.error('找不到 typescript。请在仓库根目录运行（需其 node_modules 里有 typescript）。')
  process.exit(2)
}

const TARGET = join(process.cwd(), 'src/core/Player.ts')
const CLASS_NAME = 'Player'

/**
 * 允许是 public 的实例属性。每条都要写清「谁在用、为什么必须公开」——
 * 登记本身是「这是有意对外」的承诺。**空表才是理想状态**，不是目标。
 */
const ALLOWED_PUBLIC_FIELDS = {
  root: '宿主根节点（只读）：接入方需要它做容器级全屏 requestFullscreen(player.root) 与自绘 UI 挂载',
  media: '原生媒体句柄（只读）：接入方要读 currentTime / playbackRate 等逐帧精度属性',
}

let fail = 0
const bad = (msg) => {
  console.log('  FAIL  ' + msg)
  fail++
}

const src = ts.createSourceFile(
  TARGET,
  readFileSync(TARGET, 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
)

let cls = null
for (const st of src.statements) {
  if (ts.isClassDeclaration(st) && st.name && st.name.text === CLASS_NAME) {
    cls = st
    break
  }
}
if (!cls) {
  bad('未找到 class ' + CLASS_NAME + '（' + relative(process.cwd(), TARGET) + '）')
  console.log('\nVISIBILITY CHECK FAILED')
  process.exit(1)
}

const modsOf = (node) => (ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [])
const hasMod = (node, kind) => modsOf(node).some((m) => m.kind === kind)
const lineOf = (node) => src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1
const relPath = relative(process.cwd(), TARGET).split('\\').join('/')

const publicFields = []
const publicMethods = []

for (const m of cls.members) {
  if (hasMod(m, ts.SyntaxKind.PrivateKeyword) || hasMod(m, ts.SyntaxKind.ProtectedKeyword)) continue
  if (hasMod(m, ts.SyntaxKind.StaticKeyword)) continue
  const name = m.name && ts.isIdentifier(m.name) ? m.name.text : undefined
  if (ts.isPropertyDeclaration(m)) {
    publicFields.push({ name, line: lineOf(m), readonly: hasMod(m, ts.SyntaxKind.ReadonlyKeyword) })
  } else if (ts.isMethodDeclaration(m)) {
    publicMethods.push({ name, line: lineOf(m) })
  }
}

// ① 公开实例属性：必须在册，且只读
for (const f of publicFields) {
  const why = f.name ? ALLOWED_PUBLIC_FIELDS[f.name] : undefined
  if (!why) {
    bad(
      relPath + ':' + f.line + '  新增了公开实例属性 `' + f.name + '` —— ' +
        '若确为有意对外，请登记进 verify/visibility.mjs 的 ALLOWED_PUBLIC_FIELDS；否则加 `private`',
    )
    continue
  }
  if (!f.readonly) {
    bad(
      relPath + ':' + f.line + '  公开属性 `' + f.name + '` 没有 `readonly` —— ' +
        '公开可写字段等于把内部状态的操作权交给接入方',
    )
  }
}
if (!fail) {
  console.log(
    '  OK    公开实例属性 ' + publicFields.length + ' 个，全部在册且只读' +
      '（' + Object.keys(ALLOWED_PUBLIC_FIELDS).join(' / ') + '）',
  )
}

// ② 公开实例方法：必须在 PLAYER_PUBLIC 清单里
let methodFail = 0
for (const mth of publicMethods) {
  if (!mth.name || !PLAYER_PUBLIC.includes(mth.name)) {
    methodFail++
    bad(
      relPath + ':' + mth.line + '  公开方法 `' + mth.name + '` 不在 public-surface.mjs#PLAYER_PUBLIC 里 —— ' +
        '若为内部方法请加 `private`',
    )
  }
}
if (!methodFail) {
  console.log('  OK    公开实例方法 ' + publicMethods.length + ' 个，全部在 public-surface 清单内')
}

// ③ 白名单不得腐烂：登记的名字必须真实存在
const foundFields = new Set(publicFields.map((f) => f.name))
for (const k of Object.keys(ALLOWED_PUBLIC_FIELDS)) {
  if (!foundFields.has(k)) {
    bad('ALLOWED_PUBLIC_FIELDS 里的 `' + k + '` 已不存在于 ' + CLASS_NAME + ' —— 请从白名单移除（防止白名单腐烂）')
  }
}

console.log()
if (fail) {
  console.log('VISIBILITY CHECK FAILED（' + fail + ' 项）')
  console.log('  说明：Player 的公开面 = ALLOWED_PUBLIC_FIELDS 字段 + public-surface.mjs#PLAYER_PUBLIC 方法；')
  console.log('        新增公开成员必须显式登记，因为它会进 dist 的 .d.ts、成为对接入方的承诺。')
  process.exit(1)
}
console.log('VISIBILITY CHECK OK')
