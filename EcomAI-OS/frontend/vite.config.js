import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        // VITE_API_PROXY_TARGET lets a run point at a backend on another port
        // without editing this file. The default is the documented local one.
        target: process.env.VITE_API_PROXY_TARGET || 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  test: {
    // The regression tests render real components (the upload zone, the product
    // form) and exercise the real service modules, so they need a DOM and the
    // JSX transform. They live beside the code they cover, in `src/**`.
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{js,jsx}'],
    setupFiles: ['./src/test/setup.js'],
    restoreMocks: true,
    // Pinned rather than inherited: a developer's `.env.local` points the
    // running app at the real backend, and a test that silently switched to the
    // api path would then fail on a missing access token instead of testing
    // anything. A test that wants the api path sets the mode and re-imports.
    env: {
      VITE_AUTH_MODE: 'mock',
      VITE_DATA_MODE: 'mock',
    },
  },
})
