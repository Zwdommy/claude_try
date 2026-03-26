import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api/meshy': {
        target: 'https://api.meshy.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/meshy/, ''),
      },
      '/meshy-asset': {
        target: 'https://assets.meshy.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/meshy-asset/, ''),
      },
    },
  },
  root: '.',
  publicDir: 'public',
});
