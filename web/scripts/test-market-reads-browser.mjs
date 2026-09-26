/** Read-only browser check against a running development server. No wallet is installed. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = process.env.PHINARY_DEV_URL || 'http://127.0.0.1:3112';
const response = await fetch(new URL('/api/dev/connection', base), { signal: AbortSignal.timeout(90000) });
assert.equal(response.status, 200, 'Development connection diagnostic must pass');
const report = await response.json();
assert.ok(report.markets.length, 'A deployed market is required for this browser check');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(45000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let unavailable = false;
    let readRequests = 0;
    // Reject writes even if a future UI regression tries to issue one.
    const readMethods = new Set(['eth_call', 'eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getBalance']);
    await page.route('**/*', async route => {
        const request = route.request();
        if (request.method() === 'POST') {
            let body;
            try { body = request.postDataJSON(); } catch { /* Non-JSON asset request. */ }
            const calls = Array.isArray(body) ? body : [body];
            if (calls.some(call => call?.jsonrpc === '2.0')) {
                if (!calls.every(call => readMethods.has(call?.method))) {
                    errors.push('Unexpected non-read RPC method');
                    return route.abort();
                }
                readRequests++;
                if (unavailable) return route.abort();
            }
        }
        return route.continue();
    });
    await page.goto(base);
    await page.locator('a[href^="/market/"]').first().waitFor();
    assert.ok(readRequests > 0, 'Market list must use browser RPC reads');
    const id = report.markets[0].id;
    await page.goto(new URL(`/market/${id}`, base).href);
    await page.locator('.detail-hero h1').waitFor();
    assert.match(await page.locator('.detail-hero h1').innerText(), /ETH/);
    await mkdir('.review/phase2', { recursive: true });
    await page.screenshot({ path: '.review/phase2/market-desktop.png', fullPage: true });
    // A failure after a successful read must show Retry, not an empty market or stale price.
    unavailable = true;
    await page.getByText('Market data is unavailable.', { exact: true }).waitFor();
    assert.equal(await page.locator('.detail-hero').count(), 0);
    unavailable = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.locator('.detail-hero h1').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.review/phase2/market-mobile.png', fullPage: true });
    if (Number(report.marketCount) > 30) {
        await page.goto(new URL('/market/1', base).href);
        await page.locator('.detail-hero h1').waitFor();
    }
    await page.goto(new URL('/market/999999999999', base).href);
    await page.getByRole('heading', { name: 'Market not found', exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ block: report.blockNumber, marketCount: report.marketCount, testedMarket: id,
        checks: ['list', 'detail', 'RPC failure', 'retry recovery', 'mobile', 'older direct link when available', 'not found'],
        readRequests, pageErrors: errors.length }, null, 2));
} finally {
    await browser.close();
}
