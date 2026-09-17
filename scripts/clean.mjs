/**
 * 清理构建产物目录。
 *
 * ── 为什么需要单独一步 ──
 *
 * 构建链里**没有任何一环会清理 dist/**：
 * - 4 个 vite 配置（core / ui / react / vue）都设了 `emptyOutDir: false` —— 这是必要的，
 *   它们**串行写入同一个 `dist/`**，先跑的若清空目录会把后跑的产物删掉；
 * - `tsc --emitDeclarationOnly --outDir dist`（声明文件）本身不清理输出目录。
 *
 * 于是**任何被删除或改名的源文件都会在 `dist/` 留下孤儿**。而 `dist/` 在 `.gitignore` 内、
 * `npm pack` 打的是**磁盘上现有的 dist** —— 孤儿会被直接发布出去。
 *
 * 实测事故（0.6.0 发布前发现）：`src/reporter/` 并入 `src/plugins/`、`SentryReporter.ts` 删除之后，
 * `dist/reporter/` 仍留着 4 个文件，其中 `SentryReporter.d.ts` 声明的类**已不存在于源码**。
 * 若不清理就发布，包里会带上一份「幽灵类型」，而下游 `exports` 映射又指不到它 ——
 * 既无用、又误导（读 tarball 的人会以为 SDK 还提供 Sentry 适配器）。
 *
 * `scripts/` 与 `verify/artifacts.mjs` 是一对：本脚本**修根因**（build 前清空），
 * 那道门是**第二道保险**（即使有人绕过 build 直接 pack，也会在质量门失败）。
 */
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const target = resolve(process.cwd(), 'dist')
rmSync(target, { recursive: true, force: true })
console.log(`[clean] 已清空 ${target}`)
