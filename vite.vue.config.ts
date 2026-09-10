import { defineConfig } from 'vite'
import { resolve } from 'node:path'

// vue 适配器入口（usePlayer composable）：vue 作为外部依赖，不打包进产物。
export default defineConfig({
  build: {
    lib: {
      entry: resolve(process.cwd(), 'src/adapters/vue.ts'),
      name: 'LiveSdkVue',
      formats: ['es', 'umd'],
      fileName: (format) => (format === 'es' ? 'live-sdk-vue.es.js' : 'live-sdk-vue.umd.js'),
    },
    rollupOptions: {
      external: ['vue'],
      output: { globals: { vue: 'Vue' } },
    },
    sourcemap: true,
    minify: false,
    emptyOutDir: false,
  },
})
