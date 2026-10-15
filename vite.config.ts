import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

const src = fileURLToPath(new URL('./src', import.meta.url))

// Tauri 会把 dist/ 直接当静态资源加载，因此不能有 base 前缀。
// 也必须关掉清屏，否则 tauri dev 的输出会被 vite 的日志覆盖。
export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: { '@': src },
  },

  // Tauri 固定读取 1420 端口
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },

  build: {
    target: 'esnext',
    minify: 'esbuild',
    sourcemap: false,
    outDir: 'dist',
    // Tauri 侧支持 gzip 预压缩
    chunkSizeWarningLimit: 1500,
  },

  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // sql.js 是 WASM，加载较慢，给足超时
    testTimeout: 20_000,
  },
})
