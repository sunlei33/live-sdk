import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// core 入口：headless 内核（ESM + UMD），hls.js 作为外部依赖。
export default defineConfig({
  build: {
    lib: {
      entry: resolve(process.cwd(), 'src/index.ts'),
      name: 'LiveSdk',
      formats: ['es', 'umd'],
      fileName: (format) => (format === 'es' ? 'live-sdk.es.js' : 'live-sdk.umd.js'),
    },
    rollupOptions: {
      external: ['hls.js'],
      output: { globals: { 'hls.js': 'Hls' } },
    },
    sourcemap: true,
    minify: false,
    emptyOutDir: false, // 保留 ui 产物
  },
})
