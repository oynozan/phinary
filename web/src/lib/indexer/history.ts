import type { ActivitySnapshot } from '../activity/display.ts';
import type { PricePoint, Trade } from '../types.ts';
import { address, amount, createIndexerClient, integer, object, text, units } from './graphql.ts';

export interface IndexedMarket {
    id: number; up: `0x${string}`; down: `0x${string}`; expiry: number; cutoff: number;
    strike: number; volume: number; tradeCount: number; createdAt: number;
}
export interface MarketHistory {
    asOf: number; indexedBlock: number; market: IndexedMarket; prices: PricePoint[]; trades: Trade[];
}
export const marketFields = 'id up down expiry openTime window cutoffBuffer lnStrikeWad volumeUsdc tradeCount createdAt';
const pageFields = 'pageInfo { hasNextPage endCursor }';
const tradeFields = 'id marketId account side isBuy qty usdc avgPriceWad timestamp txHash attributedBy';
const tradeQuery = `query($where: tradeFilter!, $after: String) {
 rows: trades(where: $where, orderBy: "timestamp", orderDirection: "asc", limit: 250, after: $after) {
 items { ${tradeFields} } ${pageFields} } }`;
const priceQuery = `query($where: priceSnapshotFilter!, $after: String) {
 rows: priceSnapshots(where: $where, orderBy: "timestamp", orderDirection: "asc", limit: 250, after: $after) {
 items { id marketId timestamp midUp askUp bidUp ethLnWad varE36 } ${pageFields} } }`;
export function parseMarket(value: unknown): IndexedMarket {
    const row = object(value), id = Number(units(row.id));
    if (!Number.isSafeInteger(id) || id < 1) throw Error('Invalid indexed market');
    const expiry = integer(row.expiry), strike = Math.exp(Number(units(row.lnStrikeWad)) / 1e18);
    if (!Number.isFinite(strike) || strike <= 0) throw Error('Invalid strike');
    return { id, up: address(row.up), down: address(row.down), expiry,
        cutoff: expiry - integer(row.window) - integer(row.cutoffBuffer), strike,
        volume: amount(row.volumeUsdc), tradeCount: integer(row.tradeCount), createdAt: integer(row.createdAt) };
}
export function parseTrade(row: Record<string, unknown>): Trade {
    if (row.attributedBy !== 'transfer' && row.attributedBy !== 'txFrom') throw Error('Invalid trade attribution');
    if (row.side !== 'UP' && row.side !== 'DOWN' || typeof row.isBuy !== 'boolean') throw Error('Invalid trade');
    const txHash = text(row.txHash);
    if (!/^0x[\da-f]{64}$/i.test(txHash)) throw Error('Invalid transaction hash');
    const marketId = Number(units(row.marketId));
    if (!Number.isSafeInteger(marketId) || marketId < 1) throw Error('Invalid market ID');
    return { id: text(row.id), kind: 'trade', marketId, account: address(row.account), side: row.side === 'UP' ? 'up' : 'down',
        isBuy: row.isBuy, qty: amount(row.qty), usdc: amount(row.usdc), price: amount(row.avgPriceWad, 18),
        time: integer(row.timestamp), txHash: txHash as `0x${string}`, attributedBy: row.attributedBy };
}
export function parsePrice(row: Record<string, unknown>): PricePoint {
    const mid = amount(row.midUp, 18), ask = amount(row.askUp, 18), bid = amount(row.bidUp, 18);
    const eth = Math.exp(Number(units(row.ethLnWad)) / 1e18);
    // Probability is bounded by 1; executable ask includes spread and can exceed 1.
    if (mid > 1 || bid > 1 || !Number.isFinite(eth) || eth <= 0) throw Error('Invalid price');
    return { t: integer(row.timestamp), mid, ask, bid, eth };
}
type Indexer = ReturnType<typeof createIndexerClient>;
export interface IndexedHead { asOf: number; indexedBlock: number }
export async function verifyIndexer(indexer: Indexer, chainId: number,
    verify: (market: IndexedMarket, head: IndexedHead) => Promise<void>, now = Date.now() / 1000): Promise<IndexedHead> {
    await indexer.ready();
    const data = await indexer.query(`{ _meta { status } market(id: "1") { ${marketFields} } }`);
    const chains = Object.values(object(object(data._meta).status)).map(object);
    if (chains.length !== 1 || integer(chains[0].id) !== chainId) throw Error('Wrong indexer chain');
    const block = object(chains[0].block), head = { asOf: integer(block.timestamp), indexedBlock: integer(block.number) };
    if (now - head.asOf > 60 || head.asOf > now + 30) throw Error('Indexer is delayed');
    await verify(parseMarket(data.market), head);
    return head;
}
export async function readIndexedMarket(indexer: Indexer, id: number, head: IndexedHead): Promise<MarketHistory> {
    const data = await indexer.query(`query($id: BigInt!) { market(id: $id) { ${marketFields} } }`, { id: String(id) });
    const market = parseMarket(data.market);
    if (market.id !== id) throw Error('Wrong indexed market');
    const [prices, trades] = await Promise.all([
        indexer.pages(priceQuery, { where: { marketId: String(id), timestamp_lte: head.asOf } }),
        indexer.pages(tradeQuery, { where: { marketId: String(id), timestamp_lte: head.asOf } }),
    ]);
    for (const row of [...prices, ...trades]) {
        if (units(row.marketId) !== BigInt(id) || integer(row.timestamp) > head.asOf) throw Error('Unexpected history row');
    }
    return { ...head, market,
        prices: prices.filter(row => integer(row.timestamp) < market.cutoff && units(row.varE36) > 0n).map(parsePrice),
        trades: trades.map(parseTrade) };
}
export async function readIndexedActivity(indexer: Indexer, head: IndexedHead): Promise<ActivitySnapshot> {
    const rows = await indexer.pages(tradeQuery, { where: { timestamp_gt: head.asOf - 7200, timestamp_lte: head.asOf } });
    const trades = rows.map(parseTrade);
    if (trades.some(t => t.time <= head.asOf - 7200 || t.time > head.asOf)) throw Error('Unexpected activity timestamp');
    const previous = trades.filter(t => t.time <= head.asOf - 3600);
    return { asOf: head.asOf, tradesComplete: true, accountingComplete: false, realized: [],
        previousHour: { volume: previous.reduce((sum, t) => sum + t.usdc, 0), trades: previous.length },
        events: trades.filter(t => t.time > head.asOf - 3600).map(t => ({ id: t.id, timestamp: t.time, account: t.account,
            action: t.isBuy ? 'Buy' : 'Sell', side: t.side, market: `Market #${t.marketId}`, amount: t.qty, total: t.usdc, attributedBy: t.attributedBy })) };
}
