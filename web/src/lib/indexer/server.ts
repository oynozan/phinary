import { predictionHookAbi } from '@phinary/swap-sdk';
import { createChainClient } from '../onchain/client.ts';
import { getConnectionConfig } from '../onchain/config.ts';
import { createIndexerClient } from './graphql.ts';
import { verifyIndexer } from './history.ts';

/** Only Next route handlers import this module; upstream URLs stay on the server. */
export async function connectIndexer() {
    const endpoint = process.env.PHINARY_INDEXER_URL || (process.env.NODE_ENV === 'development' ? 'http://127.0.0.1:42069' : '');
    if (!endpoint) throw Error('Indexer not configured');
    const indexer = createIndexerClient(endpoint);
    const config = getConnectionConfig(), client = createChainClient(config);
    const head = await verifyIndexer(indexer, config.chainId, async (market, indexed) => {
        const blockNumber = BigInt(indexed.indexedBlock);
        if (blockNumber < (config.deployBlock ?? 0n)) throw Error('Indexer predates deployment');
        const [chain, block, info] = await Promise.all([
            client.getChainId(), client.getBlock({ blockNumber }),
            client.readContract({ address: config.predictionHook, abi: predictionHookAbi, functionName: 'marketInfo', args: [BigInt(market.id)], blockNumber }),
        ]);
        if (chain !== config.chainId || Number(block.timestamp) !== indexed.asOf ||
            info.yes.toLowerCase() !== market.up.toLowerCase() || info.no.toLowerCase() !== market.down.toLowerCase()) {
            throw Error('Indexer does not match configured deployment');
        }
    });
    return { indexer, head };
}
