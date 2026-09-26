import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const appDir = dirname(fileURLToPath(import.meta.url))
const repoDir = resolve(appDir, '..')

const deploymentFile = resolve(appDir, process.env['DEPLOYMENT_FILE'] ?? '../deployments/unichain-sepolia.json')

// Addresses baked in at build time; URL parameters still override them at runtime
function readDeployment(): Record<string, unknown> {
  if (!existsSync(deploymentFile)) {
    return {}
  }
  try {
    return JSON.parse(readFileSync(deploymentFile, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Restarts the dev server when the deployment file changes, so a migration shows up without a manual restart */
function reloadOnDeployment(): Plugin {
  return {
    name: 'reload-on-deployment',
    configureServer(server) {
      server.watcher.add(deploymentFile)
      server.watcher.on('change', (path) => {
        if (resolve(path) === deploymentFile) {
          void server.restart()
        }
      })
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [react(), reloadOnDeployment()],
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
