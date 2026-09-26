/** Render real UI components with isolated inputs; no wallet or RPC calls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

test('portfolio offers one connection prompt and preserves connected dashboard states', async () => {
    const cache = join(process.cwd(), 'node_modules/.cache');
    await mkdir(cache, { recursive: true });
    const dir = await mkdtemp(join(cache, 'first-impression-'));
    const outfile = join(dir, 'fixture.cjs');
    try {
        await build({
            absWorkingDir: process.cwd(), outfile, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
            loader: { '.css': 'empty' },
            stdin: { resolveDir: process.cwd(), sourcefile: 'portfolio-fixture.tsx', loader: 'tsx', contents: `
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PortfolioScreen } from './src/components/portfolio/portfolio-screen';
export function render(availability) {
 return renderToStaticMarkup(<PortfolioScreen display={{availability, rows: [], realized: null}} now={1000} notice={<><span>Connect your wallet to view your portfolio.</span><button>Connect wallet</button></>}/>);
}` },
        });
        const { render } = createRequire(import.meta.url)(outfile);
        const disconnected = render('disconnected');
        assert.match(disconnected, /class="portfolio-connect" aria-label="Connect wallet"/);
        assert.match(disconnected, /Connect your wallet to view your portfolio\./);
        assert.equal((disconnected.match(/>Connect wallet<\/button>/g) ?? []).length, 1);
        assert.doesNotMatch(disconnected, /Portfolio summary|>N\/A<|>Claim all</);
        for (const availability of ['ready', 'loading', 'error', 'wrong-network']) {
            const html = render(availability);
            assert.match(html, /Portfolio summary/, availability);
            assert.match(html, /Open Positions/, availability);
            assert.match(html, /Claimable Positions/, availability);
            assert.doesNotMatch(html, /class="portfolio-connect"/, availability);
        }
    } finally { await rm(dir, { recursive: true, force: true }); }
});
