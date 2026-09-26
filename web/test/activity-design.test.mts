import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

test('activity only presents rankings and outcome metrics with accounting data', async () => {
    const cache = join(process.cwd(), 'node_modules/.cache');
    await mkdir(cache, { recursive: true });
    const dir = await mkdtemp(join(cache, 'activity-design-'));
    const outfile = join(dir, 'fixture.cjs');
    try {
        await build({
            absWorkingDir: process.cwd(), outfile, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent', loader: { '.css': 'empty' },
            stdin: { resolveDir: process.cwd(), sourcefile: 'activity-fixture.tsx', loader: 'tsx', contents: `
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActivityScreen } from './src/components/activity/activity-screen';
export const render = display => renderToStaticMarkup(<ActivityScreen display={display}/>);
` },
        });
        const { render } = createRequire(import.meta.url)(outfile);
        const snapshot = { events: [], realized: [], tradesComplete: true, accountingComplete: false, asOf: 1000 };
        for (const status of ['ready', 'paused', 'error', 'loading']) {
            const html = render({ status, snapshot: status === 'ready' || status === 'paused' ? snapshot : null });
            assert.match(html, /Profit rankings and win rates are not available yet/);
            assert.match(html, /Live Feed/);
            assert.doesNotMatch(html, /id="activity-traders-title"|Wins 1h|Losses 1h|activity-win-ring/);
        }
        const known = render({ status: 'ready', snapshot: { ...snapshot, accountingComplete: true, realized: [{ id: '1', timestamp: 900, account: '0x1111111111111111111111111111111111111111', profit: 12, outcome: 'win' }] } });
        assert.match(known, /id="activity-traders-title"/);
        assert.match(known, /Wins 1h/);
        assert.match(known, /\+\$12/);
        assert.doesNotMatch(known, /Profit rankings and win rates are not available yet/);
    } finally { await rm(dir, { recursive: true, force: true }); }
});
