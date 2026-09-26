import { connectIndexer } from '@/lib/indexer/server';
import { readIndexedMarket } from '@/lib/indexer/history';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
    const { id } = await context.params;
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) return Response.json({ error: 'Invalid market ID' }, { status: 400 });
    try {
        const { indexer, head } = await connectIndexer();
        return Response.json(await readIndexedMarket(indexer, Number(id), head), { headers: { 'Cache-Control': 'no-store' } });
    } catch {
        return Response.json({ error: 'Market history temporarily unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
}
