import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [tailwindcss()],
  resolve: { dedupe: ['react', 'react-dom'] },
  esbuild: { jsx: 'automatic' },
  build: {
    outDir: '../dist/src/entries/web/public',
    emptyOutDir: false,
    target: 'es2022',
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '^/api/(?![^/?]+\\.[cm]?[jt]sx?(?:\\?|$))': {
        target: process.env.RSI_WEB_API_URL || 'http://127.0.0.1:4317',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (request) => {
            request.setHeader(
              'origin',
              process.env.RSI_WEB_API_URL || 'http://127.0.0.1:4317',
            );
          });
        },
      },
    },
  },
});
