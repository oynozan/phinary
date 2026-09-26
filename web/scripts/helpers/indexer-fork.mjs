/** Isolated Ponder source copy + fresh PGlite. Never opens the user's existing DB. */
import { mkdtemp, cp, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
export async function startIndexerFixture(f) {
    const root = await mkdtemp(path.join(tmpdir(), 'phinary-phase6-'));
    const cwd = path.join(root, 'indexer'); await mkdir(cwd);
    for (const name of ['package.json', 'ponder.config.ts', 'ponder.schema.ts', 'ponder-env.d.ts', 'tsconfig.json', 'src']) {
        await cp(path.join(repo, 'indexer', name), path.join(cwd, name), { recursive: true });
    }
    for (const name of ['packages', 'deployments']) await symlink(path.join(repo, name), path.join(root, name));
    await symlink(path.join(repo, 'indexer/node_modules'), path.join(cwd, 'node_modules'));
    const url = 'http://127.0.0.1:42071';
    let processHandle, logs = '';
    async function stop() {
        if (!processHandle || processHandle.exitCode !== null) return;
        const done = new Promise(resolve => processHandle.once('exit', resolve));
        processHandle.kill('SIGTERM'); await done;
    }
    function start() {
        const env = { ...process.env, PONDER_NETWORK: 'unichain-sepolia', PONDER_RPC_URL_1301: f.rpcUrl, SNAPSHOT_START_BLOCK: '63569470' };
        delete env.DATABASE_URL; delete env.DATABASE_PRIVATE_URL;
        processHandle = spawn(process.execPath, ['node_modules/ponder/dist/esm/bin/ponder.js', 'dev', '--port', '42071', '--disable-ui'], {
            cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
        });
        processHandle.stdout.on('data', b => { logs += b; }); processHandle.stderr.on('data', b => { logs += b; });
    }
    async function query(query, variables = {}) {
        const r = await fetch(`${url}/graphql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10000) });
        const result = await r.json(); if (!r.ok || result.errors) throw Error(JSON.stringify(result)); return result.data;
    }
    async function until(check, label, timeout = 120000) {
        const end = Date.now() + timeout; let last;
        while (Date.now() < end) {
            if (processHandle?.exitCode !== null) throw Error(logs.slice(-5000));
            try { const result = await check(); if (result) return result; } catch (e) { last = e; }
            await new Promise(r => setTimeout(r, 500));
        }
        throw Error(`${label}: ${last?.message ?? 'timed out'}\n${logs.slice(-4000)}`);
    }
    async function ready() { await until(async () => (await fetch(`${url}/ready`)).ok, 'Indexer readiness'); }
    start();
    return { root, url, query, until, ready, stop, async restart() { await stop(); start(); await ready(); },
        async save() { await mkdir('.review/phase6', { recursive: true }); await writeFile('.review/phase6/indexer.log', logs); },
    };
}
