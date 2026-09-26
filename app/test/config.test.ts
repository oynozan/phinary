import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isLocalUrl, resolveConfig } from '../src/config.ts'
import { UNICHAIN_SEPOLIA, UNICHAIN_SEPOLIA_RPC_URL } from '../src/sdk.ts'

const HOOK = '0x87b4583e8aC0d3399686b26393c411f33d0f6Aa8'
const OTHER = '0x1111111111111111111111111111111111112aa8'

describe('resolveConfig', () => {
  it('defaults to the public 1301 RPC and the Stack A contracts, with no hook', () => {
    const cfg = resolveConfig({})
    assert.equal(cfg.chainId, 1301)
    assert.equal(cfg.rpcUrl, UNICHAIN_SEPOLIA_RPC_URL)
    assert.equal(cfg.isLocalRpc, false)
    assert.equal(cfg.devTools, false)
    assert.equal(cfg.hook, undefined)
    assert.equal(cfg.hookSource, 'none')
    assert.equal(cfg.contracts.universalRouter, UNICHAIN_SEPOLIA.universalRouter)
    assert.equal(cfg.contracts.v4Quoter, UNICHAIN_SEPOLIA.v4Quoter)
    assert.equal(cfg.contracts.permit2, UNICHAIN_SEPOLIA.permit2)
    assert.equal(cfg.marketLimit, 24)
  })

  it('reads the hook and oracle from the deployment file', () => {
    const cfg = resolveConfig({ deployment: { chainId: 1301, predictionHook: HOOK.toLowerCase(), underlyingOracle: OTHER } })
    assert.equal(cfg.hook, HOOK)
    assert.equal(cfg.hookSource, 'deployment')
    assert.equal(cfg.underlyingOracle?.toLowerCase(), OTHER)
  })

  it('lets URL parameters win over env, env over the deployment and the deployment over a saved hook', () => {
    const deployment = { predictionHook: OTHER }
    assert.equal(resolveConfig({ search: `?hook=${HOOK}`, env: { VITE_PREDICTION_HOOK: OTHER }, deployment }).hookSource, 'url')
    assert.equal(resolveConfig({ env: { VITE_PREDICTION_HOOK: HOOK }, deployment }).hook, HOOK)
    assert.equal(resolveConfig({ deployment, savedHook: HOOK }).hookSource, 'deployment')
    assert.equal(resolveConfig({ savedHook: HOOK }).hookSource, 'saved')
  })

  it('turns on dev tools for a local RPC from ?rpc= and lets ?dev=0 turn them off', () => {
    const cfg = resolveConfig({ search: '?rpc=http://127.0.0.1:8545' })
    assert.equal(cfg.rpcUrl, 'http://127.0.0.1:8545')
    assert.equal(cfg.isLocalRpc, true)
    assert.equal(cfg.devTools, true)
    assert.equal(resolveConfig({ search: '?rpc=http://localhost:8545&dev=0' }).devTools, false)
    assert.equal(resolveConfig({ env: { VITE_RPC_URL: 'http://localhost:9999' } }).rpcUrl, 'http://localhost:9999')
  })

  it('warns about invalid address overrides and keeps the defaults', () => {
    const cfg = resolveConfig({ search: '?hook=0x123&router=nope' })
    assert.equal(cfg.hook, undefined)
    assert.equal(cfg.contracts.universalRouter, UNICHAIN_SEPOLIA.universalRouter)
    assert.equal(cfg.warnings.length, 2)
  })

  it('ignores a deployment file for another chain but still honours ?hook=', () => {
    const cfg = resolveConfig({ search: `?hook=${HOOK}`, deployment: { chainId: 1, predictionHook: OTHER } })
    assert.equal(cfg.hook, HOOK)
    assert.ok(cfg.warnings.some((w) => w.includes('Deployment file ignored')))
  })

  it('supports another chain id with explicit addresses', () => {
    const cfg = resolveConfig({ search: `?chainId=31337&hook=${HOOK}&quoter=${OTHER}` })
    assert.equal(cfg.chainId, 31337)
    assert.equal(cfg.contracts.chainId, 31337)
    assert.equal(cfg.contracts.v4Quoter.toLowerCase(), OTHER)
  })

  it('uses the deployment tracks only for the deployment hook', () => {
    const S1 = '0x8f1b371e41FeCBb825d0baAB19f906E645C760e0'
    const deployment = { chainId: 1301, predictionHook: HOOK, marketSchedulers: [S1] }
    assert.deepEqual(resolveConfig({ deployment }).marketSchedulers, [S1])
    assert.deepEqual(resolveConfig({ deployment, search: `?hook=${HOOK.toLowerCase()}` }).marketSchedulers, [S1])
    assert.deepEqual(resolveConfig({ deployment, search: `?hook=${OTHER}` }).marketSchedulers, [])
  })

  it('clamps ?markets=', () => {
    assert.equal(resolveConfig({ search: '?markets=500' }).marketLimit, 200)
    assert.equal(resolveConfig({ search: '?markets=abc' }).marketLimit, 24)
  })
})

describe('isLocalUrl', () => {
  it('recognises loopback hosts only', () => {
    assert.equal(isLocalUrl('http://127.0.0.1:8545'), true)
    assert.equal(isLocalUrl('http://localhost:8545'), true)
    assert.equal(isLocalUrl('https://unichain-sepolia.drpc.org'), false)
    assert.equal(isLocalUrl('not a url'), false)
  })
})
