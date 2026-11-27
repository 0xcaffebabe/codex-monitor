import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({
  plugins: [react()],
  build: { outDir: path.join(process.env.MONITOR_BUILD_DIR || 'dist', 'public') },
  server: { proxy: { '/api': 'http://127.0.0.1:9902' } },
});
