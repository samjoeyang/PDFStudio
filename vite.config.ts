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
    // 桌面端本地资源无需按旧浏览器降级；关闭 chunk 级 esbuild 转译与压缩，
    // 构建过程不依赖临时文件，也便于直接调试打包结果。
    target: 'esnext',
    minify: false,
    cssMinify: false,
    outDir: 'dist',
    chunkSizeWarningLimit: 2000,
  },
});
