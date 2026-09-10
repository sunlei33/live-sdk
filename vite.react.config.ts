import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// react 适配器入口（usePlayer hook）：react 作为外部依赖，不打包进产物。
export default defineConfig({
  build: {
    lib: {
      entry: resolve(process.cwd(), 'src/adapters/react.ts'),
      name: 'LiveSdkReact',
      formats: ['es', 'umd'],
      fileName: (format) => (format === 'es' ? 'live-sdk-react.es.js' : 'live-sdk-react.umd.js'),
    },
    rollupOptions: {
      external: ['react'],
      output: { globals: { react: 'React' } },
    },
    sourcemap: true,
    minify: false,
    emptyOutDir: false, // 保留 core/ui 产物
  },
})
