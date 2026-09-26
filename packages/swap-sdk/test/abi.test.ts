import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type Abi, toFunctionSelector, toEventSelector } from 'viem'
import { marketGatekeeperAbi, marketSchedulerAbi, outcomeTokenAbi, predictionHookAbi } from '../src/index.ts'

const out = join(dirname(fileURLToPath(import.meta.url)), '../../../out')

function selectors(abi: Abi): string[] {
  return abi
    .flatMap((x) => (x.type === 'function' ? [toFunctionSelector(x)] : x.type === 'event' ? [toEventSelector(x)] : []))
    .sort()
}

describe('generated ABIs match the Foundry build', () => {
  for (const [file, name, abi] of [
    ['IPredictionHook.sol', 'IPredictionHook', predictionHookAbi],
    ['OutcomeToken.sol', 'OutcomeToken', outcomeTokenAbi],
    ['IMarketScheduler.sol', 'IMarketScheduler', marketSchedulerAbi],
    ['IMarketGatekeeper.sol', 'IMarketGatekeeper', marketGatekeeperAbi],
  ] as const) {
    const path = join(out, file, `${name}.json`)
    it(name, { skip: !existsSync(path) && 'forge build output missing' }, () => {
      const built = JSON.parse(readFileSync(path, 'utf8')).abi as Abi
      assert.deepEqual(selectors(abi as Abi), selectors(built))
    })
  }

  it('exposes the registry reads used by listMarkets', () => {
    const names = new Set<string>(predictionHookAbi.filter((x) => x.type === 'function').map((x) => x.name))
    for (const n of ['marketCount', 'marketInfo', 'poolKeys', 'quote', 'marketOfPool', 'usdc'])
      assert.ok(names.has(n), n)
  })
})
