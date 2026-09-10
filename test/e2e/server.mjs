/**
 * E2E 静态服务器。
 *
 * 只做一件事：把仓库根目录原样暴露为 HTTP。
 * 不用 `vite preview` 的原因——它绑定的是 dist 目录且会做 SPA fallback，
 * 而 harness.html 需要同时取到 /dist/*.js 与自身（/test/e2e/harness.html）。
 *
 * 端口通过 E2E_PORT 覆盖，方便本地并行跑多套。
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const port = Number(process.env.E2E_PORT || 4173)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`)
    let pathname = decodeURIComponent(url.pathname)
    if (pathname === '/') pathname = '/test/e2e/harness.html'

    // 目录穿越防护：normalize 后必须仍在 root 内
    const filePath = normalize(join(root, pathname))
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end('Forbidden')
      return
    }

    const body = await readFile(filePath)
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404).end('Not Found')
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[e2e] serving ${root} at http://127.0.0.1:${port}`)
})
