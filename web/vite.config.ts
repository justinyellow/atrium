import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    watch: { awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 } },
    proxy: {
      '/api/v1/events': { target: 'ws://localhost:3100', ws: true },
      '/api': { target: 'http://localhost:3100', xfwd: true },
      '/collab': { target: 'ws://localhost:3100', ws: true },
      // MCP + OAuth (the /oauth/consent page itself is served by the SPA)
      '^/oauth/(authorize|token|register|revoke)': { target: 'http://localhost:3100', xfwd: true },
      '/.well-known': { target: 'http://localhost:3100', xfwd: true },
      '/mcp': { target: 'http://localhost:3100', xfwd: true },
    },
  },
});
