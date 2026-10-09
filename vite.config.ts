import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/web' },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/graphql': 'http://127.0.0.1:4000', '/healthz': 'http://127.0.0.1:4000' },
  },
});
