import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    // Tauri 用的是系统 WKWebView：macOS 12 (WebKit 17613 / Safari 16 时代) 不支持
    // 类静态块、逻辑赋值等 ES2022 语法。pdfjs-dist 4.x 的主包里就有 static {} ，
    // 不降级会导致整个 ES module 解析失败、窗口全白。统一降到 ES2020。
    target: 'es2020',
    minify: false,
    cssMinify: false,
    outDir: 'dist',
    chunkSizeWarningLimit: 2000,
  },
});
