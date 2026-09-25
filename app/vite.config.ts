import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const appDir = dirname(fileURLToPath(import.meta.url))
const repoDir = resolve(appDir, '..')

// Addresses baked in at build time; URL parameters still override them at runtime
function readDeployment(): Record<string, unknown> {
  const file = resolve(appDir, process.env['DEPLOYMENT_FILE'] ?? '../deployments/unichain-sepolia.json')
  if (!existsSync(file)) {
    return {}
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    __DEPLOYMENT__: JSON.stringify(readDeployment()),
  },
  resolve: {
    dedupe: ['viem'],
  },
  server: {
    port: 5173,
    fs: { allow: [appDir, resolve(repoDir, 'packages/swap-sdk')] },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
})
