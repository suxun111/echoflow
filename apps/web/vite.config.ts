import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  const port = Number(env.WEB_PORT || 4173)

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
    },
    test: {
      environment: 'jsdom',
      env: { NODE_ENV: 'test' },
      globals: true,
      setupFiles: './src/test/setup.ts',
    },
  }
})
