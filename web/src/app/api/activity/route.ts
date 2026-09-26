import { connectIndexer } from '@/lib/indexer/server';
import { readIndexedActivity } from '@/lib/indexer/history';
export const dynamic = 'force-dynamic';
export async function GET() {
    try {
        const { indexer, head } = await connectIndexer();
        return Response.json(await readIndexedActivity(indexer, head), { headers: { 'Cache-Control': 'no-store' } });
    } catch {
        return Response.json({ error: 'Activity temporarily unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
}
