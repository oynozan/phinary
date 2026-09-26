/** Read-only real-indexer smoke test. Start Next with PHINARY_INDEXER_URL set. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const base = process.env.PHINARY_DEV_URL || 'http://127.0.0.1:3112';
const id = process.env.PHINARY_HISTORY_MARKET_ID;
assert.ok(id && /^[1-9]\d*$/.test(id), 'Set PHINARY_HISTORY_MARKET_ID to an indexed market with price snapshots');
const historyResponse = await fetch(`${base}/api/markets/${id}/history`);
assert.equal(historyResponse.status, 200);
const history = await historyResponse.json();
assert.ok(history.prices.length > 0, 'Real indexer must provide price history');
const activityResponse = await fetch(`${base}/api/activity`);
assert.equal(activityResponse.status, 200);
const activity = await activityResponse.json();
assert.equal(activity.tradesComplete, true);
assert.equal(activity.accountingComplete, false);
assert.equal((await fetch(`${base}/api/markets/invalid/history`)).status, 400);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(45000);
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const reads = new Set(['eth_call', 'eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getBalance']);
    let offline = false, historyRequests = 0;
    await page.route('**/*', async route => {
        const request = route.request();
        if (request.url().includes(`/api/markets/${id}/history`)) {
            historyRequests++;
            if (offline) return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
        }
        if (request.method() === 'POST') {
            let body; try { body = request.postDataJSON(); } catch {}
            const calls = Array.isArray(body) ? body : [body];
            if (calls.some(c => c?.jsonrpc === '2.0') && !calls.every(c => reads.has(c?.method))) {
                errors.push('Unexpected write RPC'); return route.abort();
            }
        }
        return route.continue();
    });
    await page.goto(`${base}/market/${id}`);
    await page.getByText(/UP probability history in UTC/).waitFor();
    await page.locator('.detail-hero h1').waitFor();
    await mkdir('.review/phase5', { recursive: true });
    await page.screenshot({ path: '.review/phase5/history-desktop.png', fullPage: true });
    assert.equal(historyRequests, 1, 'Chart, trades and market metadata share a request');
    offline = true;
    await page.getByText('Unable to load price history', { exact: true }).waitFor();
    await page.getByText('Unable to load trade history', { exact: true }).waitFor();
    assert.equal(await page.locator('.detail-hero h1').count(), 1, 'RPC market remains usable during history outage');
    offline = false;
    await page.getByText(/UP probability history in UTC/).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: '.review/phase5/history-mobile.png', fullPage: true });
    await page.goto(`${base}/activity`);
    await page.getByText('Accounting data unavailable.', { exact: true }).waitFor();
    if (!activity.events.length) await page.getByText('No trades in the last hour.', { exact: true }).waitFor();
    await page.screenshot({ path: '.review/phase5/activity-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: '.review/phase5/activity-desktop.png', fullPage: true });
    assert.deepEqual(errors, []);
    const report = { marketId: id, indexedBlock: history.indexedBlock, pricePoints: history.prices.length,
        trades: history.trades.length, activityEvents: activity.events.length,
        checks: ['real GraphQL history', 'shared polling', 'history outage isolates RPC', 'automatic recovery', 'desktop/mobile', 'missing accounting N/A'], pageErrors: errors };
    await writeFile('.review/phase5/report.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
