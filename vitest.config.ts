import { defineConfig } from 'vitest/config'

export default defineConfig({
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
