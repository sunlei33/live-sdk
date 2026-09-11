#!/usr/bin/env node
/**
 * live-sdk 本地发布脚本（npm publish）—— 跨平台，仅依赖 Node 内置模块。
 *
 * 用法（Windows / macOS / Linux 完全一致）：
 *   npm run release                 # 正式发布（校验 → 预览 → 确认 → 上传）
 *   npm run release:dry             # 演练：只走校验与预览，不上传、不打 tag
 *   npm run release -- --otp=123456 # 账号开启两步验证（2FA）时附带一次性口令
 *   npm run release -- --yes        # 跳过交互确认（CI / 非 TTY 环境必须显式指定）
 *   npm run release -- --skip-gate  # 跳过质量门（不推荐）
 *
 * 说明：
 *   - 质量门（test + build + verify）在本脚本内显式执行并展示结果，便于发布前 review；
 *     随后用 `npm publish --ignore-scripts` 上传，避免 prepublishOnly 重复跑一遍。
 *   - 若直接跑裸 `npm publish`，package.json 的 prepublishOnly 仍会兜底执行同样的质量门。
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as readline from 'node:readline/promises'
import process from 'node:process'

// ── 定位包根目录（脚本所在目录的上一级）──
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(ROOT)

// ── 参数解析 ──
const argv = process.argv.slice(2)
let dryRun = false
let skipGate = false
let assumeYes = false
const publishArgs = []

for (const arg of argv) {
  if (arg === '--dry-run') dryRun = true
  else if (arg === '--skip-gate') skipGate = true
  else if (arg === '--yes' || arg === '-y') assumeYes = true
  else if (arg.startsWith('--otp=')) publishArgs.push(arg)
  else if (arg === '-h' || arg === '--help') {
    console.log(
      [
        '',
        'live-sdk 本地发布脚本（npm publish）',
        '',
        '用法：',
        '  npm run release                 # 正式发布',
        '  npm run release:dry             # 演练（不上传、不打 tag）',
        '  npm run release -- --otp=123456 # 2FA 一次性口令',
        '  npm run release -- --yes        # 跳过交互确认（非 TTY 环境必需）',
        '  npm run release -- --skip-gate  # 跳过质量门（不推荐）',
        '',
      ].join('\n'),
    )
    process.exit(0)
  } else {
    console.error(`未知参数: ${arg}（用 --help 查看用法）`)
    process.exit(1)
  }
}

// ── 输出辅助（非 TTY 或 NO_COLOR 时自动去色）──
const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)
const bold = (s) => console.log(`\n${c(1, s)}`)
const info = (s) => console.log(`  ${c(36, '›')} ${s}`)
const ok = (s) => console.log(`  ${c(32, '✓')} ${s}`)
const warn = (s) => console.log(`  ${c(33, '!')} ${s}`)
const die = (s) => {
  console.error(`${c(31, '✗')} ${s}`)
  process.exit(1)
}

// ── 执行子命令（shell:true 以便 Windows 下解析 npm.cmd）──
function run(cmd, args = [], opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, ...opts })
  return r.status === 0
}
function capture(cmd) {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8' })
  return r.status === 0 ? (r.stdout || '').trim() : null
}

// ── 交互确认 ──
let rl = null
async function ask(text) {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const a = (await rl.question(text)).trim().toLowerCase()
  return a === 'y' || a === 'yes'
}
function closeRl() {
  if (rl) {
    rl.close()
    rl = null
  }
}

// ── 读取包信息 ──
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'))
const { name, version } = pkg

console.log()
console.log(c(1, `发布 ${name}@${version}${dryRun ? '  [演练模式]' : ''}`))

// ═══ 1. 前置检查 ═══
bold('1) 前置检查')

if (pkg.private === true) die('package.json 里 private=true，无法发布')
ok(`Node ${process.version} / npm ${capture('npm -v') ?? '?'}`)

// npm 登录态
const whoami = capture('npm whoami')
let loggedIn = false
if (whoami) {
  loggedIn = true
  ok(`npm 已登录：${whoami}`)
} else if (dryRun) {
  warn('npm 未登录（演练模式不阻断；正式发布前需 npm login）')
} else {
  die('npm 未登录。请先执行  npm login  后再跑本脚本')
}

// scope 归属检查：scoped 包必须拥有对应 scope，否则 publish 会 403
// 仅在已登录时检查——未登录时 npm org ls 必然失败，会产生误导性告警
if (name.startsWith('@')) {
  const scope = name.slice(1).split('/')[0]
  if (!loggedIn) {
    info('scope 检查：跳过（未登录）')
  } else if (capture(`npm org ls ${scope}`) !== null) {
    ok(`scope 检查：你属于 @${scope}`)
  } else {
    warn(`scope 检查：查不到 @${scope} 的成员关系`)
    info('原因可能是「组织不存在」或「你不是成员」——npm 对两种情况都返回 404，无法区分。')
    info('解决：① 建组织 https://www.npmjs.com/org/create（组织名即 scope 名）；')
    info(`      ② 或改用你的用户名 scope（自动拥有、免费）：npm pkg set name="@${whoami ?? '<用户名>'}/live-sdk"`)
    if (!dryRun) {
      const go = assumeYes || (await ask('  仍要继续吗？（继续很可能在 publish 阶段 403）[y/N] '))
      if (!go) {
        closeRl()
        console.log('  已取消。')
        process.exit(0)
      }
    }
  }
}

// git 工作区（仅提醒，不阻断——发布取的是构建产物）
if (existsSync(resolve(ROOT, '.git'))) {
  const dirty = capture('git status --porcelain')
  if (dirty === null) {
    info('git 检查：跳过（git 不可用）')
  } else if (dirty) {
    warn('工作区有未提交改动（不影响发布，但建议先提交以便 tag 与代码对应）')
  } else {
    ok('git 工作区干净')
  }
  const branch = capture('git rev-parse --abbrev-ref HEAD')
  if (branch && branch !== 'main') warn(`当前分支为 ${branch}（非 main）`)
}

// ═══ 2. 质量门 ═══
if (skipGate) {
  console.log()
  warn('2) 已跳过质量门（--skip-gate）')
} else {
  bold('2) 质量门：单测 → 构建 → 契约/导出/冒烟校验')
  info('npm test')
  if (!run('npm', ['test'])) die('单测未通过，已中止发布')
  info('npm run build')
  if (!run('npm', ['run', 'build'])) die('构建失败，已中止发布')
  info('npm run verify')
  if (!run('npm', ['run', 'verify'])) die('契约/冒烟校验未通过，已中止发布')
  ok('质量门全部通过')
}

// ═══ 3. 预览 ═══
bold('3) 预览发布内容（npm pack --dry-run）')
console.log()
run('npm', ['pack', '--dry-run'])

// ═══ 4. 确认 ═══
if (dryRun) {
  bold('演练结束：未上传、未打 tag。')
  console.log('  （去掉 --dry-run 即为正式发布）\n')
  closeRl()
  process.exit(0)
}

bold('4) 确认发布')
if (!process.stdin.isTTY && !assumeYes) {
  die('当前是非交互环境，请追加 --yes 明确确认发布')
}
const confirmed = assumeYes || (await ask(`  即将上传 ${name}@${version} 到 npm registry（公开）。继续？[y/N] `))
if (!confirmed) {
  closeRl()
  console.log('  已取消。')
  process.exit(0)
}
closeRl()

// ═══ 5. 发布 ═══
bold('5) 发布')
if (!run('npm', ['publish', '--ignore-scripts', ...publishArgs])) die('发布失败')
ok(`已发布：${name}@${version}`)
info(`验证：npm view ${name} version`)
info(`安装：npm i ${name}`)

// ═══ 6. 可选：打 tag 并推送 ═══
if (existsSync(resolve(ROOT, '.git'))) {
  const tag = `v${version}`
  console.log()
  const doTag = assumeYes
    ? false
    : await ask(`  现在为本次发布打 tag ${tag} 并推送到 origin？[y/N] `)
  if (doTag) {
    if (run('git', ['tag', '-a', tag, '-m', `release: ${name}@${version}`]) && run('git', ['push', 'origin', tag])) {
      ok(`已打 tag 并推送：${tag}`)
    } else {
      warn(`打 tag / 推送失败，可稍后手动：git tag -a ${tag} -m "release: ${name}@${version}" && git push origin ${tag}`)
    }
  } else {
    console.log(`  已跳过打 tag（可稍后手动：git tag -a ${tag} -m "release: ${name}@${version}" && git push origin ${tag}）`)
  }
}

closeRl()
console.log(`\n${c(1, '完成 🎉')}\n`)
