import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const interfaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../interface')

/** The Uniswap SDKs the forked web app installs; the reference for byte-for-byte encoding checks. */
export const hasInterfaceSdks = existsSync(join(interfaceRoot, 'node_modules/@uniswap/v4-sdk/package.json'))

type Any = any

export function loadUniswapSdks(): { ur: Any; v4: Any; permit2: Any; core: Any; ethers: Any } {
  const req = createRequire(join(interfaceRoot, 'package.json'))
  return {
    ur: req('@uniswap/universal-router-sdk'),
    v4: req('@uniswap/v4-sdk'),
    permit2: req('@uniswap/permit2-sdk'),
    core: req('@uniswap/sdk-core'),
    ethers: req('ethers'),
  }
}
