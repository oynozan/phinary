/** Test-only signer stays in this Node process; the page gets an EIP-1193 bridge. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startFixture } from './helpers/fork.mts';
import { erc20Abi, numberToHex } from 'viem';
import { predictionHookAbi } from '@phinary/swap-sdk';
const f = await startFixture();
const appPort = 3111;
let server, browser, page;
const errors = [];
try {
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--webpack', '-p', String(appPort), '--hostname', '127.0.0.1'], { env: { ...process.env, NEXT_PUBLIC_PHINARY_RPC_URL: f.rpcUrl, PHINARY_E2E: "1" }, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = ''; server.stdout.on('data', data => { logs += data; }); server.stderr.on('data', data => { logs += data; });
    for (let i = 0; i < 90; i++) { if (server.exitCode !== null) throw Error(logs); try { if ((await fetch(`http://127.0.0.1:${appPort}`)).ok) break; } catch {} await new Promise(r => setTimeout(r, 500)); }
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    let rejectNext = false, walletChain = 1301;
    let walletAddress = f.account.address;
    await context.exposeBinding('testWalletRequest', async (_, { method, params = [] }) => {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [walletAddress];
        if (method === 'eth_chainId') return numberToHex(walletChain);
        if ((method === 'eth_signTypedData_v4' || method === 'eth_sendTransaction') && rejectNext) { rejectNext = false; return { testError: 4001 }; }
        if (method === 'eth_signTypedData_v4') { const typed = JSON.parse(params[1]); return f.account.signTypedData(typed); }
        if (method === 'eth_sendTransaction') {
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
        await page.getByRole('button', { name: new RegExp(`^[▲▼] ${side}`) }).click();
        await input.fill('0.1');
        await enabledClick(page.getByRole('button', { name: `Buy ${side}`, exact: true }));
        await confirmed(); assert.ok(await balance(side === 'UP' ? info.yes : info.no) > 0n);
        await page.getByRole('group', { name: 'Trade mode' }).getByRole('button', { name: 'Sell', exact: true }).click();
        await input.fill('0.01');
        await enabledClick(page.getByRole('button', { name: `Sell ${side}`, exact: true }));
        await confirmed();
    }
    console.log('Browser UP/DOWN purchases and sales passed');
    // A rejection must leave balances intact and render cancellation.
    await page.getByRole('group', { name: 'Trade mode' }).getByRole('button', { name: 'Buy', exact: true }).click();
    await input.fill('0.1'); rejectNext = true;
    await enabledClick(page.getByRole('button', { name: 'Buy DOWN', exact: true }));
    await page.getByText('Cancelled in your wallet', { exact: true }).waitFor();
    // Reload while approval is pending; recovery must not send a second approval.
    await f.rpc('evm_setAutomine', [false]);
    await input.fill('0.1');
    await enabledClick(page.getByRole('button', { name: 'Buy DOWN', exact: true }));
    await page.getByRole('button', { name: 'Check confirmation', exact: true }).waitFor();
    await page.reload();
    await f.rpc('evm_mine'); await f.rpc('evm_setAutomine', [true]);
    await enabledClick(page.getByRole('button', { name: 'Check confirmation', exact: true }));
    await page.getByText('Approval confirmed. Review a fresh quote to continue buying.', { exact: true }).waitFor();
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
    await page.locator('#vault-amount').fill('1');
    await enabledClick(page.getByRole('button', { name: 'Deposit USDC', exact: true }));
    await page.getByText(/Deposit confirmed:/).waitFor();
    await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
    await enabledClick(page.getByRole('button', { name: 'Max', exact: true }));
    await enabledClick(page.getByRole('button', { name: 'Withdraw USDC', exact: true }));
    await page.getByText(/Withdrawal confirmed:/).waitFor();
    console.log('Browser Vault deposit and withdrawal passed');
    await f.rpc('evm_setNextBlockTimestamp', [f.expiry]); await f.rpc('evm_mine');
    const settled = await f.wallet.writeContract({ address: f.config.predictionHook, abi: predictionHookAbi, functionName: 'settle', args: [BigInt(f.marketId)] });
    await f.client.waitForTransactionReceipt({ hash: settled });
    await page.goto(`${url}/market/${f.marketId}`);
    await enabledClick(page.getByRole('button', { name: 'Claim', exact: true })); await confirmed();
    console.log('Browser winning claim passed');
    await mkdir('.review/v1', { recursive: true });
    for (const width of [1440, 768, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const route of ['/', `/market/${f.marketId}`, '/portfolio', '/activity', '/vault']) {
            await page.goto(`${url}${route}`); await page.getByRole('main').waitFor();
            if (route === '/vault') await page.getByText(/As of /).waitFor();
            if (route === '/portfolio') await page.getByText('Market #' + f.marketId, { exact: true }).first().waitFor();
            await page.screenshot({ path: `.review/v1/${width}-${route.replaceAll('/', '_') || 'home'}.png`, fullPage: true });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${route} overflow at ${width}`);
        }
    }
    assert.deepEqual(errors, []); console.log('Responsive routes and no browser runtime errors passed');
} catch (error) { if (page) console.log((await page.locator("body").innerText()).slice(-6000)); throw error; } finally { await browser?.close(); server?.kill('SIGTERM'); f.stop(); }
