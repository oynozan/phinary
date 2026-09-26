import { predictionHookAbi, type MarketInfo, type HookQuote } from '@phinary/swap-sdk';
import { erc20Abi, type Address } from 'viem';
import { createChainClient } from '../onchain/client.ts';
import { getConnectionConfig } from '../onchain/config.ts';
import { toMarket } from '../onchain/market-adapter.ts';
import { payoutPerToken } from '../phase.ts';
import type { PortfolioRow } from './view-model.ts';

/** Complete registry scan; a failed chunk rejects the snapshot instead of hiding holdings. */
export async function readPortfolio(account: Address, client = createChainClient(), config = getConnectionConfig()) {
    const [chainId, block] = await Promise.all([client.getChainId(), client.getBlock()]);
    if (chainId !== config.chainId) throw new Error('Wrong RPC network');
    const count = await client.readContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: 'marketCount', blockNumber: block.number });
    if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Registry exceeds supported range');
    const rows: PortfolioRow[] = [];
    for (let start = 1; start <= Number(count); start += 50) {
        const ids = Array.from({ length: Math.min(50, Number(count) - start + 1) }, (_, i) => start + i);
        const info = await client.multicall({ contracts: ids.map(id => ({ address: config.predictionHook, abi: predictionHookAbi, functionName: 'marketInfo', args: [BigInt(id)] } as const)), allowFailure: false, blockNumber: block.number, multicallAddress: config.multicall3 }) as MarketInfo[];
        const balances = await client.multicall({ contracts: info.flatMap(m => [m.yes, m.no].map(address => ({ address, abi: erc20Abi, functionName: 'balanceOf', args: [account] } as const))), allowFailure: false, blockNumber: block.number, multicallAddress: config.multicall3 });
        const held = ids.map((id, i) => ({ id, info: info[i], up: balances[2 * i], down: balances[2 * i + 1] })).filter(m => m.up > 0n || m.down > 0n);
        const quotes = held.length ? await client.multicall({ contracts: held.map(m => ({ address: config.predictionHook, abi: predictionHookAbi, functionName: 'quote', args: [BigInt(m.id)] } as const)), allowFailure: true, blockNumber: block.number, multicallAddress: config.multicall3 }) : [];
        held.forEach((position, i) => {
            const result = quotes[i];
            const market = toMarket(position.id, position.info, 0, result?.status === 'success' ? result.result as HookQuote : undefined, Number(block.timestamp));
            for (const side of ['up', 'down'] as const) {
                const quantity = position[side];
                if (!quantity) continue;
                const payout = payoutPerToken(market.phase, side);
                const currentPrice = payout ?? market.quote?.[side === 'up' ? 'bidUp' : 'bidDown'] ?? null;
                rows.push({ id: `${market.id}:${side}`, marketId: market.id, question: market.oracle?.toLowerCase() === config.underlyingOracle.toLowerCase() ? `ETH > $${market.strike.toFixed(2)} at ${new Date(market.expiry * 1000).toISOString()}` : `Market #${market.id}`, expiry: market.expiry, cutoff: market.cutoff, openTime: market.openTime, phase: market.phase, tradable: Boolean(market.quote?.tradable), side, quantity, avgCost: null, currentPrice, value: currentPrice === null ? null : Number(quantity) / 1e6 * currentPrice, profit: null, profitPercent: null, settledAt: null, disposition: 'held' });
            }
        });
    }
    return { rows, timestamp: Number(block.timestamp), blockNumber: block.number };
}
