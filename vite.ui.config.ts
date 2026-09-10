import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// ui 入口：默认 UI 包（L1–L5 便捷层），hls.js 作为外部依赖。
export default defineConfig({
  build: {
    lib: {
      entry: resolve(process.cwd(), 'src/ui/index.ts'),
      name: 'LiveSdkUI',
      formats: ['es', 'umd'],
      fileName: (format) => (format === 'es' ? 'live-sdk-ui.es.js' : 'live-sdk-ui.umd.js'),
    },
    rollupOptions: {
      external: ['hls.js'],
      output: { globals: { 'hls.js': 'Hls' } },
    },
    sourcemap: true,
    minify: false,
    emptyOutDir: false,
  },
})
