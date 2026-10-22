import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/wow-forever-tool/', // GitHub Pages serves the site at /<repo-name>/
  plugins: [react()],
  // data/config/*.json lives outside app/ and is imported directly
  server: { fs: { allow: ['..'] } },
})
