import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // This is needed for the dev server to work
  base: './',
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  optimizeDeps: {
    include: ['@shared/protocol.js', '@shared/lifecycle-log.js'],
  },
  build: {
    commonjsOptions: {
      include: [/shared\//, /node_modules/],
    },
  },
});