import type { MarketHistory } from './history.ts';
import type { Market } from '../types.ts';
import { address, integer, object } from './graphql.ts';

export function parseHistory(value: unknown, id: number, now = Date.now() / 1000): MarketHistory {
    const data = object(value), market = object(data.market);
    const asOf = integer(data.asOf);
    if (now - asOf > 60 || asOf > now + 30 || integer(market.id) !== id) throw Error('Invalid history snapshot');
    integer(data.indexedBlock); address(market.up); address(market.down);
    const positive = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    for (const field of ['volume', 'strike', 'expiry', 'cutoff', 'createdAt', 'tradeCount']) {
        if (!positive(market[field])) throw Error('Invalid market history');
    }
    if (!Array.isArray(data.prices) || !Array.isArray(data.trades)) throw Error('Invalid history rows');
    for (const value of data.prices) {
        const row = object(value);
        if (!positive(row.t) || Number(row.t) > asOf || !positive(row.eth) ||
            !['mid', 'ask', 'bid'].every(key => positive(row[key]) && Number(row[key]) <= 1)) throw Error('Invalid price history');
    }
    for (const value of data.trades) {
        const row = object(value);
        address(row.account);
        if (row.marketId !== id || row.kind !== 'trade' || !['up', 'down'].includes(String(row.side)) ||
            typeof row.isBuy !== 'boolean' || typeof row.id !== 'string' || !/^0x[\da-f]{64}$/i.test(String(row.txHash)) ||
            !['qty', 'usdc', 'price', 'time'].every(key => positive(row[key])) || Number(row.time) > asOf ||
            !['transfer', 'txFrom'].includes(String(row.attributedBy))) throw Error('Invalid trade history');
    }
    return value as MarketHistory;
}

/** Historical metadata never overrides execution prices or contract state. */
export function withHistory(market: Market, history?: MarketHistory): Market {
    const indexed = history?.market;
    if (!indexed || indexed.id !== market.id || indexed.up.toLowerCase() !== market.up.toLowerCase() ||
        indexed.down.toLowerCase() !== market.down.toLowerCase()) return market;
    return { ...market, volume: indexed.volume, tradeCount: indexed.tradeCount, createdAt: indexed.createdAt };
}
