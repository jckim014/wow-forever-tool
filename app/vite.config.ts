import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/wow-forever-shuffle/',
  plugins: [react()],
  // data/config/*.json lives outside app/ and is imported directly
  server: { fs: { allow: ['..'] } },
})
