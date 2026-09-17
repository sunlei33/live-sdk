#!/usr/bin/env node
/**
 * 分层依赖门：把「谁可以依赖谁」写成**机器可检的矩阵**，越界即构建失败。
 *
 * ── 为什么需要这道门 ──
 *
 * 架构文档能写下分层，但**不阻止**后来者顺手 `import` 一个实现。实测（P0 之前的真实状态）：
 * `core/Player.ts` 直接 import 了 `HlsKernel`（→ `hls.js`）、`NativeKernel`、`WebEnvAdapter`、
 * `ConsoleReporter`、`LivePolling`、`MediaProxy` —— 于是「换内核 / 换媒体面 / 换宿主」
 * 三件事**每一件都必须改 core**。文档里写着「层间只依赖抽象不依赖实现」，代码里不是。
 *
 * 这道门把那条约定变成**构建期失败**：它一红，就说明架构正在退化。
 *
 * ── 判据（只约束运行时依赖）──
 *
 * 1. **跨层 import 矩阵**（见 `ALLOW`）：`core` 不得 import 任何实现层（kernel/env/plugins/ui/adapters）。
 * 2. **不得依赖「读平台」的 utils**：`utils/` 里既有纯函数也有平台读数（如 `readElementSize`），
 *    因此不靠人工白名单，而是**扫描该模块是否引用 DOM 全局**来判断 —— 读平台的模块
 *    不得被 `core` / `kernel` / `env` / `plugins` 引用（实现层也只在 Web 平台侧用它们）。
 * 3. **禁止 DOM 全局值**：`core` 内不得出现 `document.` / `window.` / `navigator.` / `createElement`
 *    等**运行时**引用。
 *
 * ── 它证明了什么、没证明什么（勿过度解读）──
 *
 * 证明：依赖方向符合架构约定（运行时层面）。
 * **未证明类型层面的平台中立**：`core` 里仍允许把 `platform.media.raw as HTMLVideoElement` 这类
 * **类型收窄**（编译期擦除、不产生运行时耦合）。这是 P1 的**有意取舍**：公开类型 `player.media`
 * 保持 `HTMLVideoElement` 不变，代价是非 Web 宿主需要再放宽一次类型（见 spec §3.9 的「已知局限」）。
 * 因此本门**不能**被读成「core 已经完全与平台无关」。
 *
 * ── 自测记录（2026-09-17，全部实跑）──
 *
 * | 越界写法 | 结果 |
 * |---|---|
 * | `core` 里 `import { readBuffers } from '../utils/buffer'` | FAIL ✓（buffer 因签名含 `TimeRanges` 被判平台专有） |
 * | `core` 里写 `'MediaSource' in window` | FAIL ✓（这条原先漏判 —— 正则要求点号） |
 * | `core` 里做类型收窄 `x as HTMLVideoElement` | **放行 ✓**（有意：类型是编译期擦除，不是运行时耦合） |
 * | `core` 里写 `document.createElement('div')` | FAIL ✓（原有能力，未被放宽判据削弱） |
 *
 * 退出码非 0 即失败（已接入 `npm run verify`）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')

/** 允许的跨层依赖（key 为层名，值为可依赖的层名集合）。`platform` 是装配层，允许依赖一切。 */
const ALLOW = {
  core: new Set(['core', 'utils', 'types']),
  kernel: new Set(['kernel', 'utils', 'types']),
  env: new Set(['utils', 'types']),
  plugins: new Set(['core', 'utils', 'types']),
  ui: new Set(['core', 'utils', 'types', 'platform']),
  adapters: new Set(['core', 'utils', 'types']),
  platform: new Set(['core', 'kernel', 'env', 'plugins', 'ui', 'adapters', 'utils', 'types', 'platform']),
  utils: new Set(['utils', 'types']),
}

/**
 * 需要「不得依赖读平台 utils」的层。
 *
 * **只有 `core`**：它是唯一需要平台中立的层。`kernel` / `env` / `plugins` 是**实现层**，
 * 本来就绑平台（`HlsKernel` 用 `readBuffers` 读 `<video>.buffered` 天经地义），
 * 对它们套这条会把门装反 —— 它要拦的是「core 被实现细节渗透」，不是「实现层用了平台能力」。
 */
const NO_PLATFORM_UTILS = new Set(['core'])

/** 需要「不得出现 DOM 全局值」的层。 */
const NO_DOM_VALUES = new Set(['core'])

/** 仓库根下的**契约模块**（`src/types.ts` / `src/constants.ts` / `src/index.ts`）视作 "types" 桶。 */
const ROOT_MODULES = new Set(['types', 'constants', 'index'])

/**
 * `core` 内**不得出现的 DOM 全局值**（真去访问全局对象）。
 *
 * 只认**运行时引用**，**不认类型名** —— core 里有合法的类型收窄
 * （`platform.media.raw as HTMLVideoElement`，编译期擦除、无运行时耦合，见文件头「未证明」一节）。
 * 把类型名并进这条会误报 core 的每一次收窄，所以它比下面那条**窄**。
 */
const DOM_GLOBAL_VALUE_RE =
  /\b(document|window|navigator)\s*\.|\bin\s+(?:window|document|navigator)\b|document\.createElement|\bcreateElement\s*\(|\.appendChild\s*\(|\.querySelector\s*\(/

/**
 * 判断一个 `utils/` 模块**是否属于平台实现**（用于「core 不得依赖读平台的 utils」）。
 *
 * 判据比上面那条**宽**，因为问的不是同一个问题：这条问「这个模块是不是 Web 平台专有」，
 * 而 Web 专有**不一定**去访问全局对象。原判据只看 `document.` / `window.`，实测漏判过两处：
 *
 * 1. `utils/fullscreen.ts`（现 `platform/web/fullscreen.ts`）：只读**元素自有成员**
 *    （`el.requestFullscreen` / `video.webkitDisplayingFullscreen` / `el.contains`），
 *    从不碰全局对象 → 被判为「纯函数」，可它的每个分支都是 Web 全屏 API；
 * 2. `utils/sniffer.ts`（已按语义拆解）：写的是 `'MediaSource' in window` —— **`in`，没有点号**。
 *
 * 故这里额外认：`in window`、以及**引用 DOM 类型名**。
 *
 * ⚠️ 正则判据先天可被绕过（本仓库已被绕两次：只匹配单引号的 import 正则、以及这条原先漏掉 `in window`）。
 * **它只是提醒，不是保证** —— 新写「平台专有但纯」的模块时请按语义自行归位，别只信这道门。
 */
const PLATFORM_HINT_RE =
  /\b(document|window|navigator)\s*\.|\bin\s+(?:window|document|navigator)\b|document\.createElement|\bcreateElement\s*\(|\.appendChild\s*\(|\.querySelector\s*\(|\b(HTMLVideoElement|HTMLMediaElement|HTMLImageElement|HTMLDivElement|HTMLElement|SVGElement|TimeRanges|MediaSource|ManagedMediaSource)\b/

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

/** 剔除注释后再判断：注释里提到 `document` / `getBoundingClientRect` 不算依赖（`surface.mjs` 的教训）。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const files = walk(SRC)
const layerOf = (file) => relative(SRC, file).split(sep)[0].replace(/\.ts$/, '')

// 先算：每个 utils 模块是否「读平台」
const platformUtils = new Set()
for (const f of files) {
  const rel = relative(SRC, f).split(sep).join('/')
  if (!rel.startsWith('utils/')) continue
  if (PLATFORM_HINT_RE.test(stripComments(readFileSync(f, 'utf8')))) platformUtils.add(rel.replace(/\.ts$/, ''))
}

let fail = 0
const bad = (msg) => {
  console.log(`  FAIL  ${msg}`)
  fail++
}

// ① 跨层 import 矩阵
// ⚠️ 必须同时接受单引号与双引号：本仓代码用单引号，但**只写单引号会让双引号 import 静默逃过检查**
// （自测时踩到过：用双引号写越界 import，门全绿）。门的正则与"被检查的代码"是两回事，别假设风格统一。
const IMPORT_RE = /from\s+['"]((?:\.\.?\/)+[^'"]+)['"]/g
let checked = 0
for (const f of files) {
  const layer = layerOf(f)
  const allowed = ALLOW[layer]
  if (!allowed) continue
  const code = stripComments(readFileSync(f, 'utf8'))
  for (const m of code.matchAll(IMPORT_RE)) {
    const spec = m[1]
    // 解析相对路径 → 归一化后的 src 内路径
    const resolved = join(f, '..', spec).split(sep).join('/')
    const relToSrc = resolved.slice(resolved.indexOf('/src/') + 5)
    const targetRaw = relToSrc.split('/')[0].replace(/\.ts$/, '')
    const target = ROOT_MODULES.has(targetRaw) ? 'types' : targetRaw
    const relPath = relative(ROOT, f).split(sep).join('/')
    checked++

    // 同层内互相引用永远允许
    if (target === layer) continue

    if (!allowed.has(target)) {
      bad(`${relPath}  →  ${target}/（${layer} 层不允许依赖 ${target}）`)
      continue
    }
    // ② 读平台的 utils 不得被 core 及其下依赖
    if (target === 'utils' && NO_PLATFORM_UTILS.has(layer)) {
      const utilName = `utils/${relToSrc.split('/')[1]?.replace(/\.ts$/, '')}`
      if (platformUtils.has(utilName)) {
        bad(`${relPath}  →  ${utilName}（该 utils 读平台，不应被 ${layer} 依赖）`)
      }
    }
  }
}
if (!fail) console.log(`  OK    跨层 import ${checked} 处，方向符合矩阵`)

// ③ DOM 全局值
let domHits = 0
for (const f of files) {
  if (!NO_DOM_VALUES.has(layerOf(f))) continue
  const code = stripComments(readFileSync(f, 'utf8'))
  code.split(/\r?\n/).forEach((line, i) => {
    if (DOM_GLOBAL_VALUE_RE.test(line)) {
      domHits++
      bad(`${relative(ROOT, f).split(sep).join('/')}:${i + 1} 引用了 DOM 全局值：${line.trim().slice(0, 80)}`)
    }
  })
}
if (!domHits) console.log('  OK    core 内无 DOM 全局值引用（document / window / navigator）')

console.log()
if (fail) {
  console.log(`LAYERS CHECK FAILED（${fail} 项）`)
  console.log('  说明：core 不得依赖实现层；换媒体面 / 换内核 / 换宿主都不应改 core。')
  process.exit(1)
}
console.log('LAYERS CHECK OK')
