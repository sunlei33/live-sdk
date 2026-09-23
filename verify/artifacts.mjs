#!/usr/bin/env node
/**
 * 产物卫生检查：`dist/` ↔ `src/` ↔ `package.json` 三方路径自洽。
 *
 * ── 为什么需要这道门 ──
 *
 * `dist/` 在 `.gitignore` 内，且历史上**没有任何一步会清理它**（见 `scripts/clean.mjs` 的说明：
 * 4 个 vite 配置串行写入同一个 dist，故都是 `emptyOutDir: false`；tsc 声明输出也不清理）。
 * 结果：**被删除或改名的源文件会在 dist 留下孤儿**，而 `npm pack` 打的正是磁盘上的 dist ——
 * 孤儿会被一起发布。
 *
 * 实测（0.6.0 发布前）：`SentryReporter.ts` 删除、`reporter/` 并入 `plugins/` 之后，
 * `dist/reporter/` 仍留着 4 个文件，其中 `SentryReporter.d.ts` 声明的类**已不存在于源码**。
 * 根因已由 `scripts/clean.mjs` 修掉（build 前清空 dist），本脚本是**第二道保险**：
 * 即使有人绕过 `npm run build` 直接 `npm pack`，也会在这里失败。
 *
 * ── 检查项 ──
 * 1. `dist/**\/*.d.ts` 必须能对应到 `src/**\/*.ts`（否则是孤儿声明）；
 * 2. `package.json` 的 `exports` 每个目标必须真实存在（否则下游 import 报模块找不到）；
 * 3. `dist/*.es.js` 必须都在 `exports` 里被引用（否则是无人引用的产物）。
 *
 * ── 它证明了什么、没证明什么 ──
 * 证明：产物、源码、导出清单三者**在路径层面自洽**。
 * 未证明：产物**内容**正确 —— 那由 `verify/exports.mjs`（运行时逐名比对导出）、
 * `verify/smoke.mjs`（装配链路）与 E2E 承担。也**不检查** `.map` / `.umd.js`：
 * UMD 只供 CDN `<script>` 使用，不经 `exports` 解析，其对应关系由 vite 保证。
 *
 * 退出码非 0 即失败（已接入 `npm run verify`）。
 */
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
/** 报告里的路径统一成正斜杠（Windows 下  返回反斜杠，读起来别扭） */
const posix = (p) => p.split(sep).join('/')
const DIST = join(ROOT, 'dist')
const SRC = join(ROOT, 'src')

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

if (!existsSync(DIST)) {
  console.log('FAILED: dist/ 不存在 —— 请先 `npm run build`（本检查针对构建产物）')
  process.exit(1)
}

let fail = 0
const pass = (msg) => console.log(`  OK    ${msg}`)
const bad = (msg) => {
  console.log(`  FAIL  ${msg}`)
  fail++
}

// ── 1. dist/**/*.d.ts 必须有对应源文件 ──────────────────────────────
const decls = walk(DIST).filter((f) => f.endsWith('.d.ts'))
const orphans = []
for (const f of decls) {
  // dist/core/Player.d.ts → src/core/Player.ts
  const rel = relative(DIST, f).replace(/\.d\.ts$/, '.ts')
  if (!existsSync(join(SRC, rel))) orphans.push(`${posix(relative(ROOT, f))}  ← 无对应 src/${rel}`)
}
if (orphans.length) {
  bad(`孤儿声明文件 ${orphans.length} 个（源文件已删除/改名，但 dist 未清理）：`)
  for (const o of orphans) console.log(`          ${o}`)
  console.log('        修法：`npm run clean && npm run build`（build 已内置 clean）')
} else {
  pass(`声明文件 ${decls.length} 个，全部能对应到 src/`)
}

// ── 2. exports 目标必须存在 ────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const targets = []
const collect = (node) => {
  if (typeof node === 'string') {
    if (node.startsWith('./')) targets.push(node)
    return
  }
  if (node && typeof node === 'object') for (const v of Object.values(node)) collect(v)
}
collect(pkg.exports ?? {})

const missing = targets.filter((t) => !existsSync(join(ROOT, t)))
if (missing.length) {
  bad(`package.json exports 指向了不存在的文件 ${missing.length} 个：`)
  for (const m of missing) console.log(`          ${m}`)
} else {
  pass(`exports 的 ${targets.length} 个目标全部存在`)
}

// ── 3. dist 顶层 .es.js 必须都被 exports 引用 ───────────────────────
const referenced = new Set(targets.map((t) => t.replace(/^\.\//, '')))
const bundles = readdirSync(DIST).filter((n) => n.endsWith('.es.js'))
const unreferenced = bundles.filter((n) => !referenced.has(`dist/${n}`))
if (unreferenced.length) {
  bad(`dist 顶层存在未被 exports 引用的产物 ${unreferenced.length} 个：${unreferenced.join('、')}`)
} else {
  pass(`dist 顶层 ${bundles.length} 个 .es.js 产物均被 exports 引用`)
}

console.log()
if (fail) {
  console.log(`ARTIFACTS CHECK FAILED（${fail} 项）`)
  process.exit(1)
}
console.log('ARTIFACTS CHECK OK')
