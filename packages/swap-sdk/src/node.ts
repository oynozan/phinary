import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type PredictionDeployment, parseDeployment } from './deployments.ts'

export * from './index.ts'

/** `<repo>/deployments/unichain-sepolia.json`, or `$PREDICTION_DEPLOYMENT` when set. */
export function defaultDeploymentPath(): string {
  if (process.env['PREDICTION_DEPLOYMENT']) {
    return resolve(process.env['PREDICTION_DEPLOYMENT'])
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../deployments/unichain-sepolia.json')
}

/** Reads the deployment file. A missing file yields the chain defaults with no hook, so callers can still quote Uniswap pools. */
export function loadDeployment(
  path: string = defaultDeploymentPath(),
): PredictionDeployment & { source: string; found: boolean } {
  if (!existsSync(path)) {
    return { ...parseDeployment({}), source: path, found: false }
  }
  return { ...parseDeployment(JSON.parse(readFileSync(path, 'utf8'))), source: path, found: true }
}
