import { failureKinds, type MarketFailure } from '@/lib/onchain/market-diagnostics';

const host = globalThis as typeof globalThis & { marketFailures?: MarketFailure[] };
const headers = { 'Cache-Control': 'no-store' };
export function GET() {
    if (process.env.NODE_ENV !== 'development') return new Response(null, { status: 404 });
    return Response.json(host.marketFailures ?? [], { headers });
}
export async function POST(request: Request) {
    if (process.env.NODE_ENV !== 'development') return new Response(null, { status: 404 });
    if (request.headers.get('origin') !== new URL(request.url).origin) return new Response(null, { status: 403 });
    const text = await request.text();
    if (text.length > 4096) return new Response(null, { status: 413 });
    try {
        const value = JSON.parse(text);
        const numeric = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
        if (!numeric(value.at) || !numeric(value.elapsedMs) || !(value.marketId === null || numeric(value.marketId)) ||
            !(value.httpStatus === null || numeric(value.httpStatus)) || !(value.rpcCode === null || numeric(value.rpcCode)) ||
            !failureKinds.includes(value.kind) || !['chain', 'head', 'tracks', 'count', 'markets', 'oracle', 'market-info', 'market-params', 'snapshot'].includes(value.stage)) return new Response(null, { status: 400 });
        const errorNames = Array.isArray(value.errorNames) ? value.errorNames.filter((v: unknown) => typeof v === 'string' && /^[A-Za-z]{1,70}Error$/.test(v)).slice(0,12) : [];
        const summaries = Array.isArray(value.summaries) ? value.summaries.filter((v: unknown) => typeof v === 'string').slice(0,8).map((s: string) => s.slice(0,220)) : [];
        const event: MarketFailure = { errorNames, summaries, at: value.at, elapsedMs: value.elapsedMs, marketId: value.marketId, httpStatus: value.httpStatus, rpcCode: value.rpcCode, kind: value.kind, stage: value.stage };
        host.marketFailures = [...(host.marketFailures ?? []), event].slice(-100);
        console.warn('[market-read]', event);
        return new Response(null, { status: 204 });
    } catch { return new Response(null, { status: 400 }); }
}
