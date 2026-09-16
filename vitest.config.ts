import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// 与 `verify/tsconfig.json` 的 `paths` 对齐：让测试与 `examples/` 能按**包名**导入。
// 这样 examples/ 里的代码就是接入方复制走的样子（不必为了在仓库内跑通而改成相对路径）。
//
// ⚠️ 顺序要紧：Vite 的对象式 alias 按 `startsWith` 匹配，更具体的子路径必须排在 `live-sdk` 之前，
// 否则 `live-sdk/ui` 会先被 `live-sdk` 吃掉、被错误改写成 `src/index.ts/ui`。
const alias = {
  'live-sdk/ui': resolve(process.cwd(), 'src/ui/index.ts'),
  'live-sdk/react': resolve(process.cwd(), 'src/adapters/react.ts'),
  'live-sdk/vue': resolve(process.cwd(), 'src/adapters/vue.ts'),
  'live-sdk': resolve(process.cwd(), 'src/index.ts'),
}

export default defineConfig({
  resolve: { alias },
  test: {
    // 单测直接跑 src 的 TS 源码（不经 dist 构建），修改即测，反馈最快。
    include: ['test/**/*.test.ts'],
    environment: 'node', // DOM 由 test/fixtures/dom.ts 自建替身提供，不依赖 jsdom
    globals: false,
    // 媒体事件是异步派发的，给足余量避免偶发超时
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'src/ui/**', 'src/adapters/**'],
      reporter: ['text', 'html'],
    },
  },
})
