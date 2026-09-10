import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // LAN/tunnel testing is opt-in: run `HOST=0.0.0.0 npm run dev:server` and
    // `npm run dev:client -- --host` together. WebRTC + MediaRecorder want a
    // secure context, so a tunnel (https) is the reliable path for a phone.
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
  build: { target: 'es2022' },
});
