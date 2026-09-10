import fs from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The API port, read from the repo-root .env so the dashboard's dev-time
 * WebSocket target follows the API rather than duplicating its default.
 */
function readApiPort(): string {
  try {
    const env = fs.readFileSync(path.resolve(__dirname, '../../.env'), 'utf8');
    const match = /^PORT=(.+)$/m.exec(env);
    return match ? match[1]!.trim().replace(/^["']|["']$/g, '') : '4100';
  } catch {
    return '4100';
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  define: {
    __WVS_API_PORT__: JSON.stringify(readApiPort()),
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:4100',
        changeOrigin: true,
      },
      // No '/ws' proxy entry: with Vite running on Bun (which `bun run dev`
      // uses), the dev proxy accepts an upgrade and then never forwards it, so
      // the socket hangs in CONNECTING. The dashboard therefore opens its
      // WebSocket against the API origin directly - see
      // src/providers/websocket-provider.tsx. Verified against Vite 6.4.3: the
      // same config proxies correctly when Vite runs on Node.
    },
  },
});
