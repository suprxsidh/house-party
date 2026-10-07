import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Three entry pages: /host (TV), /play (phones), /kart (kart-royale base game).
export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      input: {
        host: resolve(import.meta.dirname, 'host/index.html'),
        play: resolve(import.meta.dirname, 'play/index.html'),
        kart: resolve(import.meta.dirname, 'kart/index.html'),
      },
    },
  },
});
