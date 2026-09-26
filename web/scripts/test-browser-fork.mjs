/** Test-only signer stays in this Node process; the page gets an EIP-1193 bridge. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startFixture } from './helpers/fork.mts';
import { startIndexerFixture } from './helpers/indexer-fork.mjs';
import { erc20Abi, numberToHex, parseAbi } from 'viem';
import { predictionHookAbi } from '@phinary/swap-sdk';
const indexed = process.env.PHINARY_INDEXER_E2E === '1';
const f = await startFixture({ wallClock: indexed });
let indexer;
const appPort = 3111;
let server, browser, page;
const errors = [];
const tradeChecks = [];
try {
    if (indexed) {
        await f.rpc('anvil_mine', ['0x80', '0x0']);
        await f.rpc('evm_setIntervalMining', [1]);
        indexer = await startIndexerFixture(f); await indexer.ready();
        console.log('Phase 6: isolated indexer ready');
    }
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--webpack', '-p', String(appPort), '--hostname', '127.0.0.1'], { env: { ...process.env, NEXT_PUBLIC_PHINARY_RPC_URL: f.rpcUrl, PHINARY_E2E: "1", ...(indexer ? { PHINARY_INDEXER_URL: indexer.url } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = ''; server.stdout.on('data', data => { logs += data; }); server.stderr.on('data', data => { logs += data; });
    for (let i = 0; i < 90; i++) { if (server.exitCode !== null) throw Error(logs); try { if ((await fetch(`http://127.0.0.1:${appPort}`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 500)); }
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    let rejectNext = false, walletChain = 1301, submissions = 0;
    let walletAddress = f.account.address;
    await context.exposeBinding('testWalletRequest', async (_, { method, params = [] }) => {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [walletAddress];
        if (method === 'eth_chainId') return numberToHex(walletChain);
        if ((method === 'eth_signTypedData_v4' || method === 'eth_sendTransaction') && rejectNext) { rejectNext = false; return { testError: 4001 }; }
        if (method === 'eth_signTypedData_v4') { const typed = JSON.parse(params[1]); return f.account.signTypedData(typed); }
        if (method === 'eth_sendTransaction') {
            submissions++;
            const tx = params[0]; assert.equal(tx.from.toLowerCase(), f.account.address.toLowerCase());
            return f.wallet.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0), ...(tx.gas ? { gas: BigInt(tx.gas) } : {}) });
        }
        if (method === 'wallet_switchEthereumChain') return null;
        return f.rpc(method, params);
    });
    await context.addInitScript(() => {
        const handlers = new Map();
        window.ethereum = { emit: event => { for (const fn of handlers.get(event) ?? []) fn(); }, request: async args => { const value = await window.testWalletRequest(args); if (value?.testError) throw { code: value.testError, message: 'Rejected by test wallet' }; return value; }, on(event, fn) { handlers.set(event, [...(handlers.get(event) ?? []), fn]); }, removeListener(event, fn) { handlers.set(event, (handlers.get(event) ?? []).filter(x => x !== fn)); } };
    });
    page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(45000);
    const url = `http://127.0.0.1:${appPort}`;
    await page.goto(`${url}/market/${f.marketId}`);
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).last().click();
    await page.getByRole('button', { name: 'Browser wallet', exact: true }).click();
    const input = page.locator('#trade-amount');
    const enabledClick = async locator => { await locator.waitFor(); await page.waitForFunction(el => !el.disabled, await locator.elementHandle()); await locator.click(); };
    const confirmed = async () => page.getByText('Transaction confirmed. Check your updated balance.', { exact: true }).waitFor();
    const info = await f.client.readContract({ address: f.config.predictionHook, abi: predictionHookAbi, functionName: 'marketInfo', args: [BigInt(f.marketId)] });
    const balance = token => f.client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [f.account.address] });
    for (const side of ['UP', 'DOWN']) {
        const token = side === 'UP' ? info.yes : info.no;
        const cashBeforeBuy = await balance(f.config.usdc), tokensBeforeBuy = await balance(token);
        await page.getByRole('button', { name: new RegExp(`^[▲▼] ${side}`) }).click();
        await input.fill('0.1');
        await enabledClick(page.getByRole('button', { name: `Buy ${side}`, exact: true }));
        await confirmed();
        assert.equal(cashBeforeBuy - await balance(f.config.usdc), 100000n);
        assert.ok(await balance(token) > tokensBeforeBuy);
        tradeChecks.push({ side, isBuy: true, qty: String(await balance(token) - tokensBeforeBuy), usdc: String(cashBeforeBuy - await balance(f.config.usdc)) });
        const cashBeforeSell = await balance(f.config.usdc), tokensBeforeSell = await balance(token);
        await page.getByRole('group', { name: 'Trade mode' }).getByRole('button', { name: 'Sell', exact: true }).click();
        await input.fill('0.01');
        await enabledClick(page.getByRole('button', { name: `Sell ${side}`, exact: true }));
        await confirmed();
        assert.equal(tokensBeforeSell - await balance(token), 10000n);
        assert.ok(await balance(f.config.usdc) > cashBeforeSell);
        tradeChecks.push({ side, isBuy: false, qty: String(tokensBeforeSell - await balance(token)), usdc: String(await balance(f.config.usdc) - cashBeforeSell) });
    }
    console.log('Browser UP/DOWN purchases and sales passed');
    if (indexer) {
        const rows = await indexer.until(async () => {
            const d = await indexer.query(`{ trades(where: {marketId: "${f.marketId}"}) { items { id account side isBuy qty usdc txHash } } }`);
            return d.trades.items.length === 4 && d.trades.items;
        }, 'Four indexed browser trades');
        for (const check of tradeChecks) {
            const row = rows.find(t => t.side === check.side && t.isBuy === check.isBuy);
            assert.equal(row.qty, check.qty); assert.equal(row.usdc, check.usdc);
        }
        for (const side of ['UP', 'DOWN']) {
            const own = rows.filter(t => t.side === side);
            assert.equal(own.length, 2); assert.ok(own.every(t => t.account.toLowerCase() === f.account.address.toLowerCase()));
            assert.equal(own.find(t => t.isBuy).usdc, '100000'); assert.equal(own.find(t => !t.isBuy).qty, '10000');
            assert.equal(own.reduce((n, t) => n + (t.isBuy ? BigInt(t.qty) : -BigInt(t.qty)), 0n), await balance(side === 'UP' ? info.yes : info.no));
            for (const t of own) assert.equal((await f.client.getTransactionReceipt({ hash: t.txHash })).status, 'success');
        }
        await indexer.until(async () => {
            const r = await fetch(`${url}/api/markets/${f.marketId}/history`); if (!r.ok) return false;
            const d = await r.json(); return d.trades.length === 4 && d.prices.length > 0 && d.market.tradeCount === 4;
        }, 'Frontend history API');
        await page.getByRole('heading', { name: 'Recent Trades' }).waitFor();
        await page.waitForFunction(() => document.querySelectorAll('.detail-trades tbody tr').length === 4);
        await page.getByText(/UP probability history in UTC/).waitFor();
        await page.goto(`${url}/activity`);
        await page.getByRole('table', { name: 'Recent trades' }).waitFor();
        await indexer.until(async () => {
            const r = await fetch(`${url}/api/activity`); if (!r.ok) return false;
            return (await r.json()).events.filter(t => t.account.toLowerCase() === f.account.address.toLowerCase()).length === 4;
        }, 'Frontend Activity');
        await indexer.stop();
        await page.getByText('Updates delayed', { exact: true }).waitFor();
        await indexer.restart();
        await indexer.until(async () => (await fetch(`${url}/api/activity`)).ok, 'Activity recovers after indexer restart');
        await page.goto(`${url}/market/${f.marketId}`);
        await page.waitForFunction(() => document.querySelectorAll('.detail-trades tbody tr').length === 4);
        console.log('Phase 6: chain → indexer → history/Activity and restart recovery passed');
    }
    // A rejection must leave balances intact and render cancellation.
    await page.getByRole('button', { name: /^[▲▼] DOWN/ }).click();
    await page.getByRole('group', { name: 'Trade mode' }).getByRole('button', { name: 'Buy', exact: true }).click();
    await input.fill('0.1'); rejectNext = true;
    const cashBeforeReject = await balance(f.config.usdc), tokensBeforeReject = await balance(info.no);
    const beforeRejectSubmissions = submissions;
    await enabledClick(page.getByRole('button', { name: 'Buy DOWN', exact: true }));
    await page.getByText('Cancelled in your wallet', { exact: true }).waitFor();
    assert.equal(submissions, beforeRejectSubmissions);
    assert.equal(await balance(f.config.usdc), cashBeforeReject);
    assert.equal(await balance(info.no), tokensBeforeReject);
    // Reload while approval is pending; recovery must not send a second approval.
    if (indexer) await f.rpc('evm_setIntervalMining', [0]);
    await f.rpc('evm_setAutomine', [false]);
    await input.fill('0.1');
    await enabledClick(page.getByRole('button', { name: 'Buy DOWN', exact: true }));
    await page.getByRole('button', { name: 'Check confirmation', exact: true }).waitFor();
    const submissionsBeforeReload = submissions;
    await page.reload();
    await f.rpc('evm_mine'); await f.rpc('evm_setAutomine', [true]);
    if (indexer) await f.rpc('evm_setIntervalMining', [1]);
    await enabledClick(page.getByRole('button', { name: 'Check confirmation', exact: true }));
    await page.getByText('Approval confirmed. Review a fresh quote to continue buying.', { exact: true }).waitFor();
    assert.equal(submissions, submissionsBeforeReload, 'Receipt recovery must not submit another transaction');
    walletChain = 1;
    await page.evaluate(() => window.ethereum.emit('chainChanged'));
    await page.getByRole('button', { name: 'Switch to Unichain Sepolia', exact: true }).last().waitFor();
    walletChain = 1301; await page.evaluate(() => window.ethereum.emit('chainChanged'));
    walletAddress = f.config.usdc; await page.evaluate(() => window.ethereum.emit('accountsChanged'));
    await page.getByText('No tokens held in this market.', { exact: true }).waitFor();
    walletAddress = f.account.address; await page.evaluate(() => window.ethereum.emit('accountsChanged'));
    console.log('Browser pending reload, wrong-network and account isolation passed');
    await page.goto(`${url}/portfolio`);
    await page.getByRole('button', { name: /^Sell (UP|DOWN), market/ }).first().waitFor();
    await page.reload(); await page.getByRole('button', { name: /^Sell (UP|DOWN), market/ }).first().waitFor();
    await page.goto(`${url}/vault`);
    await page.getByRole('button', { name: 'Deposit USDC', exact: true }).waitFor();
    const vaultCashBefore = await balance(f.config.usdc);
    await page.locator('#vault-amount').fill('1');
    await enabledClick(page.getByRole('button', { name: 'Deposit USDC', exact: true }));
    await page.getByText(/Deposit confirmed:/).waitFor();
    assert.equal(vaultCashBefore - await balance(f.config.usdc), 1000000n);
    const vaultCashDeposited = await balance(f.config.usdc);
    await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
    await enabledClick(page.getByRole('button', { name: 'Max', exact: true }));
    await enabledClick(page.getByRole('button', { name: 'Withdraw USDC', exact: true }));
    await page.getByText(/Withdrawal confirmed:/).waitFor();
    console.log('Browser Vault deposit and withdrawal passed');
    if (indexer) await indexer.until(async () => {
        const d = await indexer.query(`{ vaultEvents(where: {account: "${f.account.address.toLowerCase()}"}) { items { kind assets shares } } }`);
        if (d.vaultEvents.items.length !== 2) return false;
        assert.ok(d.vaultEvents.items.some(e => e.kind === 'deposit' && e.assets === '1000000'));
        assert.equal(BigInt(d.vaultEvents.items.find(e => e.kind === 'withdraw').assets), await balance(f.config.usdc) - vaultCashDeposited); return true;
    }, 'Vault events');
    let nextMarketId;
    if (indexer) {
        const owner = await f.client.readContract({ address: f.config.predictionHook, abi: parseAbi(['function owner() view returns(address)']), functionName: 'owner' });
        const params = await f.client.readContract({ address: f.config.predictionHook, abi: predictionHookAbi, functionName: 'marketParams', args: [BigInt(f.marketId)] });
        const hash = await f.wallet.writeContract({ account: owner, address: f.config.predictionHook, abi: predictionHookAbi, functionName: 'createMarket', args: [{ ...params, expiry: BigInt(f.expiry + 120) }] });
        assert.equal((await f.client.waitForTransactionReceipt({ hash })).status, 'success');
        nextMarketId = Number(await f.client.readContract({ address: f.config.predictionHook, abi: predictionHookAbi, functionName: 'marketCount' }));
        await indexer.until(async () => (await indexer.query(`{ market(id: "${nextMarketId}") { status } }`)).market?.status === 'trading', 'Second market created');
    }
    await f.rpc('evm_setNextBlockTimestamp', [f.expiry]); await f.rpc('evm_mine');
    const settled = await f.wallet.writeContract({ address: f.config.predictionHook, abi: predictionHookAbi, functionName: 'settle', args: [BigInt(f.marketId)] });
    await f.client.waitForTransactionReceipt({ hash: settled });
    const claimCashBefore = await balance(f.config.usdc);
    const winningQuantity = await balance(info.yes);
    await page.goto(`${url}/market/${f.marketId}`);
    await enabledClick(page.getByRole('button', { name: 'Claim', exact: true })); await confirmed();
    assert.equal(await balance(f.config.usdc) - claimCashBefore, winningQuantity);
    console.log('Browser winning claim passed');
    if (indexer) {
        await indexer.until(async () => {
            const d = await indexer.query(`{ market(id: "${f.marketId}") { status } transfers(where: {marketId: "${f.marketId}", kind: "redeem"}) { items { from amount } } }`);
            return d.market.status === 'settled' && d.transfers.items.some(t => t.from.toLowerCase() === f.account.address.toLowerCase());
        }, 'Settlement and claim indexed');
        await f.rpc('evm_setNextBlockTimestamp', [f.expiry + 120]); await f.rpc('evm_mine');
        const nextSettle = await f.wallet.writeContract({ address: f.config.predictionHook, abi: predictionHookAbi, functionName: 'settle', args: [BigInt(nextMarketId)] });
        assert.equal((await f.client.waitForTransactionReceipt({ hash: nextSettle })).status, 'success');
        await indexer.until(async () => (await indexer.query(`{ market(id: "${nextMarketId}") { status } }`)).market?.status === 'settled', 'Second market settled');
        console.log('Phase 6: Vault, claim and two market lifecycles indexed');
    }
    await mkdir('.review/v1', { recursive: true });
    for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const route of ['/', `/market/${f.marketId}`, '/portfolio', '/activity', '/vault']) {
            await page.goto(`${url}${route}`); await page.getByRole('main').waitFor();
            if (route === '/vault') await page.getByText(/As of /).waitFor();
            if (route === '/portfolio') await page.locator('strong:visible').filter({ hasText: 'Market #' + f.marketId }).first().waitFor();
            await page.screenshot({ path: `.review/v1/${width}-${route.replaceAll('/', '_') || 'home'}.png`, fullPage: true });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${route} overflow at ${width}`);
        }
    }
    assert.deepEqual(errors, []); console.log('Responsive routes and no browser runtime errors passed');
} catch (error) { if (page) console.log((await page.locator("body").innerText()).slice(-6000)); throw error; } finally { await browser?.close(); server?.kill('SIGTERM'); await indexer?.stop(); await indexer?.save(); f.stop(); }
