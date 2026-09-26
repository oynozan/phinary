import { summarizeMarketFailure } from '@/lib/onchain/market-diagnostics';
import { connectIndexer } from '@/lib/indexer/server';
import { readIndexedMarket } from '@/lib/indexer/history';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
    const { id } = await context.params;
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) return Response.json({ error: 'Invalid market ID' }, { status: 400 });
    const started = performance.now();
    try {
        const { indexer, head } = await connectIndexer();
        return Response.json(await readIndexedMarket(indexer, Number(id), head), { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
        const diagnostic = summarizeMarketFailure(error, Number(id), performance.now() - started);
        console.warn('[market-history]', diagnostic);
        return Response.json({ error: 'Market history temporarily unavailable', ...(process.env.NODE_ENV === 'development' ? { diagnostic } : {}) }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
}
