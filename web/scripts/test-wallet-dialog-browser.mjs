/** UI-only provider fixtures: no account, signature, or transaction is sent. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
const base = process.env.PHINARY_DEV_URL ?? 'http://127.0.0.1:3113';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const evidence = '.review/wallet-dialog';
await mkdir(evidence, { recursive: true });
try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
        window.walletRequests = 0;
        const provider = { request: ({ method }) => {
            if (method !== 'eth_requestAccounts') throw Error('Unexpected fixture RPC');
            window.walletRequests++;
            return new Promise((resolve, reject) => { window.rejectWallet = () => reject({ code: 4001 }); });
        } };
        window.addEventListener('eip6963:requestProvider', () => {
            for (const [rdns, name, wallet] of [['io.metamask', 'MetaMask', provider], ['example.wallet', 'Another wallet', { request: provider.request }]]) {
                window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { rdns, name }, provider: wallet } }));
            }
        });
    });
    for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(base + '/vault');
        await page.locator('.header-wallet').click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('button', { name: 'Connect MetaMask', exact: true }).waitFor();
        await page.waitForFunction(() => { const img = document.querySelector('.wallet-option img'); return img?.complete && img.naturalWidth > 0; });
        const bounds = await dialog.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
        assert.equal(await dialog.locator('.wallet-option img').count(), 1);
        await page.screenshot({ path: `${evidence}/${width}.png` });
        await dialog.getByRole('button', { name: 'Connect MetaMask', exact: true }).click();
        await dialog.getByText('Confirm in MetaMask', { exact: true }).waitFor();
        assert.equal(await dialog.getByRole('button', { name: 'Connect Another wallet' }).isDisabled(), true);
        assert.equal(await page.evaluate(() => window.walletRequests), 1);
        await page.screenshot({ path: `${evidence}/${width}-pending.png` });
        await page.evaluate(() => window.rejectWallet());
        await page.getByText('Connection cancelled', { exact: true }).waitFor();
        await page.waitForFunction(() => !document.querySelector('.wallet-option').disabled);
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        await page.waitForFunction(() => document.querySelector('.header-wallet') === document.activeElement, undefined, { timeout: 2000 });
        console.log(`PASS ${width}px: official icon, generic fallback, pending, rejection recovery, focus return`);
    }
    const empty = await browser.newPage({ viewport: { width: 320, height: 640 } });
    await empty.goto(base + '/portfolio');
    await empty.locator('.header-wallet').click();
    await empty.getByText('No browser wallet detected').waitFor();
    assert.equal(await empty.getByRole('link', { name: 'Get MetaMask' }).getAttribute('href'), 'https://metamask.io/');
    await empty.screenshot({ path: `${evidence}/empty.png` });
    assert.deepEqual(errors, []);
    console.log('PASS no-extension state and no uncaught browser errors');
} finally { await browser.close(); }
