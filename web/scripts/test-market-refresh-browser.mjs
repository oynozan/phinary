import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
 const page = await browser.newPage();
 let fail = false;
 await page.route(/^https:\/\/(sepolia\.unichain\.org|unichain-sepolia-rpc\.publicnode\.com)\//, route => fail ? route.abort('failed') : route.continue());
 await page.goto(process.env.PHINARY_DEV_URL ?? 'http://127.0.0.1:3113', {waitUntil:'domcontentloaded'});
 const link = page.locator('a[href^="/market/"]').first();
 await link.waitFor({timeout:30000});
 await link.click();
 await page.locator('.detail-trade').waitFor({timeout:30000});
 await page.locator('.detail-trade').evaluate(el => { el.dataset.retentionTest = 'same'; });
 fail = true;
 await page.getByRole('status').filter({hasText:'Reconnecting · trading paused'}).waitFor({timeout:35000});
 assert.equal(await page.locator('.detail-trade').getAttribute('data-retention-test'), 'same');
 assert.equal(await page.locator('#trade-amount').isDisabled(), true);
 assert.equal(await page.getByText('Market data is unavailable.', {exact:true}).count(), 0);
 await mkdir('.review', {recursive:true});
 await page.screenshot({path:'.review/market-refresh-paused.png',fullPage:true});
 fail = false;
 await page.getByRole('button', {name:'Retry market updates',exact:true}).click();
 await page.getByRole('status').filter({hasText:'Reconnecting · trading paused'}).waitFor({state:'hidden',timeout:30000});
 assert.equal(await page.locator('.detail-trade').getAttribute('data-retention-test'), 'same');
 console.log('PASS failed refresh retains mounted market, disables trading, and recovers without page reset');
} finally { await browser.close(); }
