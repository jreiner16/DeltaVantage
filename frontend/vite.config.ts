import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// The project lives under a cloud-synced folder (OneDrive/Desktop), whose
// sync mangles Vite's `dist/` writes (the stray "assets 2" artifact). Emit the
// production build to a local, non-synced directory instead.
const OUT_DIR = fileURLToPath(new URL('/tmp/dv-frontend-dist/index.html', import.meta.url)).replace('/index.html', '')

// In Electron dev mode, the backend runs on 8321; in browser dev, on 8000.
const backendPort = process.env.ELECTRON === '1' ? 8321 : 8000

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        detached: resolve(__dirname, 'detachedPanel.html'),
      },
    },
  },
  server: {
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${backendPort}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
