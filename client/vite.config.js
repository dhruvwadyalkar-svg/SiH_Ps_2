import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    testTimeout: 20000,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
