import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Tonebridge ships as pure static assets: no server, no telemetry, no CDN fonts.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: '0.0.0.0',
    strictPort: true,
    // The app is meant to be opened from any host that can reach it - a phone on the LAN,
    // a sandboxed preview proxy, a static file server. Vite's default host check exists to
    // block DNS-rebinding attacks against a dev server; the preview proxy runs on its own
    // domain, so allow that family instead of turning the check off.
    allowedHosts: true,
    hmr: { overlay: false },
  },
  preview: { port: 3000, host: '0.0.0.0', allowedHosts: true },
  build: { target: 'es2022', outDir: 'dist', modulePreload: { polyfill: false } },
  worker: { format: 'es' },
});
