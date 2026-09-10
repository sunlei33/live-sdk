import { defineConfig, devices } from '@playwright/test'

/**
 * E2E 配置。
 *
 * 选 Playwright 而非 Cypress 的两个硬性理由：
 *   1. **自带 WebKit** —— 这是唯一能覆盖 NativeKernel（Safari 原生 HLS 回退）的引擎，
 *      而 NativeKernel 与 HlsKernel 的能力差异（nativeFallback / airplay）正是本次修的重点。
 *   2. 单浏览器实例 + 多 page 的成本低，且 test fixtures 与 Vitest 风格接近。
 *
 * 被测对象：`dist/` 的构建产物（不是 src），确保「发布出去的那份」是能跑的——
 * 单测跑 src 保证逻辑正确，E2E 跑 dist 保证打包链路没问题，两者互补。
 */
export default defineConfig({
  testDir: './test/e2e',
  // 与 vitest 的 *.test.ts 隔离，避免两套 runner 抢文件
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },

  use: {
    // 起一个静态服务器把仓库根目录暴露出去：harness 里用绝对路径 /dist/xx.js 引产物
    baseURL: `http://127.0.0.1:${process.env.E2E_PORT || 4173}`,
    // 本机代理（HTTP_PROXY）会让浏览器把 127.0.0.1 也走代理，导致回环连接被拒。
    // E2E 全程只访问本地静态服务器，直连即可，显式绕开代理。
    launchOptions: { proxy: { server: 'direct://', bypass: '127.0.0.1,localhost' } },
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      // 主战场：Chromium 走 HlsKernel 分支（MSE 可用）
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      // NativeKernel 分支：WebKit 原生支持 HLS，selectKernel 会走原生路径
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],

  webServer: {
    command: 'node test/e2e/server.mjs',
    url: `http://127.0.0.1:${process.env.E2E_PORT || 4173}/test/e2e/harness.html`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
})
