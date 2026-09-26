import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import assert from 'node:assert/strict';
import { createPublicClient, createWalletClient, encodeAbiParameters, erc20Abi, http, keccak256, numberToHex, pad, parseAbi, toFunctionSelector, type Hex, type Address } from 'viem';
import { unichainSepolia } from 'viem/chains';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { predictionHookAbi } from '@phinary/swap-sdk';
import deployment from '../../../deployments/unichain-sepolia.json' with { type: 'json' };
import { getConnectionConfig } from '../../src/lib/onchain/config.ts';

/** Tiny test-only oracle: fixed spot/variance and cumulativeAt(t)=tick*t. Never installed outside Anvil. */
export function oracleCode(tick = 81000): Hex {
    const push = (value: bigint) => `7f${value.toString(16).padStart(64, '0')}`;
    const ret = (value: bigint) => `${push(value)}600052600160205260406000f3`;
    const bodies = [ret(BigInt(Math.round(Math.log(3000) * 1e18))), ret(11407711613050422085329682865n), ret(0n), `600435${push(BigInt(tick))}0260005260206000f3`];
    const signatures = ['lnSpotSoBWad()', 'varianceE36()', 'decimalsShift()', 'cumulativeAt(uint32)'];
    let offset = 6 + signatures.length * 11 + 5;
    const branches = signatures.map((sig, i) => {
        const branch = `8063${toFunctionSelector(sig).slice(2)}1461${offset.toString(16).padStart(4, '0')}57`;
        offset += 2 + bodies[i].length / 2;
        return branch;
    });
    return `0x60003560e01c${branches.join('')}60006000fd${bodies.map(b => `5b50${b}`).join('')}` as Hex;
}
export async function startFixture() {
    const binary = process.env.ANVIL_BIN || [`${homedir()}/.foundry/bin/anvil`, '/opt/homebrew/bin/anvil', '/private/tmp/phinary-test-tools/node_modules/@foundry-rs/anvil-darwin-arm64/bin/anvil'].find(existsSync) || 'anvil';
    const port = await new Promise<number>((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); if (!address || typeof address === 'string') return reject(Error('No port')); server.close(() => resolve(address.port)); }); });
    const original = getConnectionConfig();
    const rpcUrl = `http://127.0.0.1:${port}`;
    const fork = spawn(binary, ['--fork-url', original.rpcUrl, '--fork-block-number', String(deployment.deployBlock + 200), '--port', String(port), '--host', '127.0.0.1', '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let startError: Error | undefined; fork.on('error', e => { startError = e; });
    const rpc = async (method: string, params: unknown[] = []) => { const response = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const value = await response.json(); if (value.error) throw Error(value.error.message); return value.result; };
    try {
        let ready = false;
        for (let i = 0; i < 80; i++) { if (startError) throw startError; try { await rpc('eth_chainId'); ready = true; break; } catch { await new Promise(r => setTimeout(r, 250)); } }
        assert.ok(ready, 'Anvil failed to start');
        assert.match(await rpc('web3_clientVersion'), /anvil/i);
        const config = { ...original, rpcUrl };
        const client = createPublicClient({ chain: unichainSepolia, transport: http(rpcUrl), pollingInterval: 100, cacheTime: 0 });
        const account = privateKeyToAccount(generatePrivateKey());
        const wallet = createWalletClient({ account, chain: unichainSepolia, transport: http(rpcUrl) });
        await rpc('anvil_setBalance', [account.address, numberToHex(10n ** 20n)]);
        const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account.address, 9n]));
        await rpc('anvil_setStorageAt', [config.usdc, slot, pad(numberToHex(1000_000000n), { size: 32 })]);
        assert.equal(await client.readContract({ address: config.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] }), 1000_000000n);
        const owner = await client.readContract({ address: config.predictionHook, abi: parseAbi(['function owner() view returns (address)']), functionName: 'owner' });
        await rpc('anvil_impersonateAccount', [owner]); await rpc('anvil_setBalance', [owner, numberToHex(10n ** 20n)]);
        const oracle: Address = '0x0000000000000000000000000000000000001234';
        await rpc('anvil_setCode', [oracle, oracleCode()]);
        const now = Number((await client.getBlock()).timestamp);
        const expiry = now + 86400;
        const hash = await wallet.writeContract({ account: owner, address: config.predictionHook, abi: predictionHookAbi, functionName: 'createMarket', args: [{ oracle, lnStrikeWad: BigInt(Math.round(Math.log(3000) * 1e18)), openTime: BigInt(now), expiry: BigInt(expiry), window: 3600, cutoffBuffer: 300, nSamples: 1800, budget: 1_000000n, quote: { h0Wad: 20000000000000000n, gammaSWad: 500000000000000n, lambdaWad: 20000000000000n, qEpochMax: 50000_000000n, pMinWad: 20000000000000000n }, sigmaMode: 0, fixedVarE36: 0n, kernel: 0, yesName: 'Frontend test UP', yesSymbol: 'UP', noName: 'Frontend test DOWN', noSymbol: 'DOWN' }] });
        assert.equal((await client.waitForTransactionReceipt({ hash })).status, 'success');
        const marketId = Number(await client.readContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: 'marketCount' }));
        return { rpc, rpcUrl, config, client, wallet, account, marketId, expiry, oracle, stop: () => fork.kill('SIGTERM') };
    } catch (error) { fork.kill('SIGTERM'); throw error; }
}
