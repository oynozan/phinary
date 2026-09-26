/** Only allowlisted metadata leaves the error chain; no RPC URLs, payloads or credentials. */
export const failureKinds = ['rate-limit', 'timeout', 'block-unavailable', 'network', 'contract-revert', 'rpc', 'empty-result', 'decode', 'unknown'] as const;
export type FailureKind = typeof failureKinds[number];
export interface MarketFailure {
    at: number; marketId: number | null; elapsedMs: number; stage: string;
    kind: FailureKind; httpStatus: number | null; rpcCode: number | null; errorNames: string[]; summaries: string[];
}
export class MarketReadError extends Error {
    constructor(public stage: string, cause: unknown) { super(`Market read failed at ${stage}`, { cause }); }
}
export async function readStage<T>(stage: string, read: () => Promise<T>): Promise<T> {
    try { return await read(); } catch (cause) { throw new MarketReadError(stage, cause); }
}
export function summarizeMarketFailure(error: unknown, marketId: number | undefined, elapsedMs: number): MarketFailure {
    let httpStatus: number | null = null, rpcCode: number | null = null;
    let kind: FailureKind = 'unknown';
    const errorNames: string[] = [];
    const summaries: string[] = [];
    const seen = new Set<unknown>();
    for (let current = error; current && typeof current === 'object' && !seen.has(current);) {
        seen.add(current);
        const e = current as { status?: unknown; code?: unknown; message?: unknown; name?: unknown; shortMessage?: unknown; cause?: unknown };
        if (typeof e.status === 'number') httpStatus = e.status;
        if (typeof e.code === 'number') rpcCode = e.code;
        if (typeof e.name === 'string' && /^[A-Za-z]{1,70}Error$/.test(e.name)) errorNames.push(e.name);
        const summary = String(e.shortMessage ?? e.message ?? '').split('\n')[0].replace(/https?:\/\/\S+/g, '[URL]').replace(/0x[0-9a-fA-F]{8,}/g, '[hex]').replace(/[A-Za-z0-9_+/=-]{32,}/g, '[token]').slice(0, 220);
        if (summaries.length < 8 && summary) summaries.push(summary);
        const text = `${e.name ?? ''} ${e.message ?? ''}`.toLowerCase();
        if (httpStatus === 429 || /rate.limit|too many requests/.test(text)) kind = 'rate-limit';
        else if (kind !== 'rate-limit' && /timeout|timed out/.test(text)) kind = 'timeout';
        else if (kind === 'unknown' && /header not found|block not found|unknown block|missing trie|state.*unavailable/.test(text)) kind = 'block-unavailable';
        else if (kind === 'unknown' && /returned no data|zero.?data|zero bytes/.test(text)) kind = 'empty-result';
        else if (kind === 'unknown' && /decode|abidecoding/.test(text)) kind = 'decode';
        else if (kind === 'unknown' && /execution reverted|contractfunctionreverted/.test(text)) kind = 'contract-revert';
        else if (kind === 'unknown' && /failed to fetch|network|http request failed/.test(text)) kind = 'network';
        current = e.cause;
    }
    if (kind === 'unknown' && rpcCode !== null) kind = 'rpc';
    return { at: Date.now(), marketId: marketId ?? null, elapsedMs: Math.round(elapsedMs),
        stage: error instanceof MarketReadError ? error.stage : 'snapshot', kind, httpStatus, rpcCode, errorNames, summaries };
}
export function reportMarketFailure(event: MarketFailure) {
    if (typeof window === 'undefined') return;
    console.warn('[market-read]', event);
    if (process.env.NODE_ENV === 'development') {
        void fetch('/api/dev/market-errors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event), keepalive: true }).catch(() => {});
    }
}
