/** Server-side transport for the existing Ponder GraphQL API. */
export function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid indexer response');
    return value as Record<string, unknown>;
}
export function integer(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw Error('Invalid indexer integer');
    return value;
}
export function text(value: unknown): string {
    if (typeof value !== 'string') throw Error('Invalid indexer text');
    return value;
}
export function units(value: unknown): bigint {
    const raw = text(value);
    if (!/^-?\d+$/.test(raw)) throw Error('Invalid indexer amount');
    return BigInt(raw);
}
export function amount(value: unknown, decimals = 6): number {
    const raw = units(value), result = Number(raw) / 10 ** decimals;
    if (raw < 0n || !Number.isFinite(result)) throw Error('Invalid indexer amount');
    return result;
}
export function address(value: unknown): `0x${string}` {
    const raw = text(value);
    if (!/^0x[\da-f]{40}$/i.test(raw)) throw Error('Invalid indexer address');
    return raw as `0x${string}`;
}
export function createIndexerClient(endpoint: string, fetcher: typeof fetch = fetch, signal = AbortSignal.timeout(8000)) {
    const base = new URL(endpoint);
    if (!['http:', 'https:'].includes(base.protocol)) throw Error('Invalid indexer URL');
    const url = (path: string) => { const next = new URL(base); next.pathname = `${base.pathname.replace(/\/$/, '')}/${path}`; return next; };
    async function query(query: string, variables: Record<string, unknown> = {}) {
        const response = await fetcher(url('graphql'), { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables }), cache: 'no-store', signal });
        if (!response.ok) throw Error('Indexer unavailable');
        const result = object(await response.json());
        if (result.errors !== undefined) throw Error('Indexer query failed');
        return object(result.data);
    }
    return {
        query,
        async ready() {
            const response = await fetcher(url('ready'), { cache: 'no-store', signal });
            if (!response.ok) throw Error('Indexer is catching up');
        },
        async pages(queryText: string, variables: Record<string, unknown>) {
            const rows: Record<string, unknown>[] = [], ids = new Set<string>(), cursors = new Set<string>();
            let after: string | null = null;
            for (let page = 0; page < 20; page++) {
                const result = object((await query(queryText, { ...variables, after })).rows);
                if (!Array.isArray(result.items)) throw Error('Invalid indexer page');
                for (const item of result.items) {
                    const row = object(item), id = text(row.id);
                    if (ids.has(id)) throw Error('Indexer pages changed while reading');
                    ids.add(id); rows.push(row);
                }
                const info = object(result.pageInfo);
                if (info.hasNextPage === false) return rows;
                if (info.hasNextPage !== true || !result.items.length) throw Error('Invalid indexer pagination');
                after = text(info.endCursor);
                if (!after || cursors.has(after)) throw Error('Indexer cursor did not advance');
                cursors.add(after);
            }
            throw Error('Indexer result exceeds page limit');
        },
    };
}
