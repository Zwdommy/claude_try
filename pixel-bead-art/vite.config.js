import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    exclude: ['manifold-3d'],
  },
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
      '/moonshot-proxy': {
        target: 'https://api.moonshot.cn',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/moonshot-proxy/, ''),
        timeout: 120000,
        proxyTimeout: 120000,
      },
    },
  },
  root: '.',
  publicDir: 'public',
});
