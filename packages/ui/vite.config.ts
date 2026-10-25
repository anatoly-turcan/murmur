import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: { proxy: { '/api': 'http://127.0.0.1:4242' } },
  build: { outDir: 'dist', emptyOutDir: true },
  test: { include: ['src/**/*.test.{ts,tsx}'], environment: 'node' },
});
