import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // 把 Vite/Vitest 的临时缓存固定在项目内，避免写入系统 Temp 时被沙箱拦截
  cacheDir: 'node_modules/.vite-cache',
  server: { host: '127.0.0.1', port: 5190, strictPort: true },
  build: {
    chunkSizeWarningLimit: 800, // three.js 本体约 680 kB，属预期
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/node_modules[\\/]three[\\/]/.test(id)) return 'three';
          if (/node_modules[\\/](@react-three|three-stdlib)[\\/]/.test(id)) return 'r3f';
          if (/node_modules[\\/]react(-dom)?[\\/]/.test(id)) return 'react';
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    reporters: 'default',
    pool: 'threads',
  },
});
