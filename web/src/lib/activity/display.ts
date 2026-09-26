/** Activity display inputs, not an indexer or public API contract. */
export interface ActivityEvent {
    id: string;
    timestamp: number;
    account: string;
    action: 'Buy' | 'Sell' | 'Claim';
    side: 'up' | 'down';
    market: string;
    amount: number | null;
    total: number | null;
}
export interface RealizedRecord {
    id: string;
    timestamp: number;
    account: string;
    profit: number | null;
    outcome: 'win' | 'loss' | 'invalid' | null;
}
export interface ActivitySnapshot {
    events: ActivityEvent[];
    realized: RealizedRecord[];
    tradesComplete: boolean;
    accountingComplete: boolean;
    asOf: number;
}
export type ActivityStatus = 'ready' | 'loading' | 'unavailable' | 'error' | 'paused';
export interface ActivityDisplay {
    status: ActivityStatus;
    snapshot: ActivitySnapshot | null;
}
const known = (n: number | null): n is number => n !== null && Number.isFinite(n);
function sum(values: (number | null)[]) { return values.every(known) ? values.reduce((a, b) => a + b, 0) : null; }
export function withinHour(timestamp: number, now: number) { return timestamp > now - 3600 && timestamp <= now; }
function recent<T extends {
    id: string;
    timestamp: number;
}>(rows: T[], now: number) { return [...new Map(rows.map(row => [row.id, row])).values()].filter(row => withinHour(row.timestamp, now)); }
export function aggregateActivity(snapshot: ActivitySnapshot) {
    const events = recent(snapshot.events, snapshot.asOf), records = recent(snapshot.realized, snapshot.asOf);
    const trades = events.filter(row => row.action !== 'Claim');
    const wins = records.filter(row => row.outcome === 'win').length, losses = records.filter(row => row.outcome === 'loss').length;
    const outcomesKnown = snapshot.accountingComplete && records.every(row => row.outcome !== null);
    const accounts = [...new Set(records.map(row => row.account.toLowerCase()))];
    const ranking = snapshot.accountingComplete ? accounts.flatMap(account => {
        const own = records.filter(row => row.account.toLowerCase() === account), profit = sum(own.map(row => row.profit));
        if (profit === null)
            return [];
        const w = own.filter(row => row.outcome === 'win').length, l = own.filter(row => row.outcome === 'loss').length;
        return [{ account, profit, volume: snapshot.tradesComplete ? sum(trades.filter(row => row.account.toLowerCase() === account).map(row => row.total)) : null, winRate: own.every(row => row.outcome !== null) && w + l ? w / (w + l) : null }];
    }).sort((a, b) => b.profit - a.profit || a.account.localeCompare(b.account)).slice(0, 10) : [];
    return { volume: snapshot.tradesComplete ? sum(trades.map(row => row.total)) : null, trades: snapshot.tradesComplete ? trades.length : null, wins: outcomesKnown ? wins : null, losses: outcomesKnown ? losses : null, winRate: outcomesKnown && wins + losses ? wins / (wins + losses) : null, feed: events.sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id)).slice(0, 12), ranking };
}
