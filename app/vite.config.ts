import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/wow-forever-tool/', // GitHub Pages serves the site at /<repo-name>/
  plugins: [react()],
  // data/config/*.json lives outside app/ and is imported directly
  server: { fs: { allow: ['..'] } },
  // Two pages: the shuffle app and the cross-faction trade tracker (trades.html)
  build: { rollupOptions: { input: { main: 'index.html', trades: 'trades.html' } } },
})
