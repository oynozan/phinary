import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

test('Vault entry hides the dashboard until connected and preserves confirmation recovery', async () => {
    const cache = join(process.cwd(), 'node_modules/.cache');
    await mkdir(cache, { recursive: true });
    const dir = await mkdtemp(join(cache, 'vault-entry-'));
    const outfile = join(dir, 'fixture.cjs');
    try {
        await build({
            absWorkingDir: process.cwd(), outfile, bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent', loader: { '.css': 'empty' },
            stdin: { resolveDir: process.cwd(), sourcefile: 'vault-entry.tsx', loader: 'tsx', contents: `
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VaultScreen } from './src/components/vault/vault-screen';
import { emptyVault } from './src/lib/vault/display';
export const render = (props = {}) => renderToStaticMarkup(<VaultScreen view={emptyVault} core={null} connected={false} wrongNetwork={false} busy={false} onConnect={()=>{}} onSwitch={()=>{}} onSubmit={async()=>{}} {...props}/>);
` },
        });
        const { render } = createRequire(import.meta.url)(outfile);
        const guest = render();
        assert.match(guest, /class="vault-connect" aria-label="Connect wallet"/);
        assert.equal((guest.match(/>Connect wallet<\/button>/g) ?? []).length, 1);
        assert.doesNotMatch(guest, /Vault metrics|Vault deposit and withdrawal|Exposure by Market|>N\/A</);
        assert.match(render({ connecting: true }), /disabled=""[^>]*>Connecting…/);
        for (const wrongNetwork of [false, true]) {
            const html = render({ connected: true, wrongNetwork });
            assert.match(html, /Vault metrics/);
            assert.match(html, /Vault deposit and withdrawal/);
            assert.match(html, /Exposure by Market/);
            assert.doesNotMatch(html, /class="vault-connect"/);
            if (wrongNetwork) assert.match(html, />Switch network<\/button>/);
        }
        const recovery = render({ pending: true, message: 'Checking receipt', onCheckPending() {} });
        assert.match(recovery, /Checking receipt/);
        assert.match(recovery, />Check confirmation<\/button>/);
    } finally { await rm(dir, { recursive: true, force: true }); }
});
