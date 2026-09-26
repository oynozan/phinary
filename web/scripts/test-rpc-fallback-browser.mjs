/** Read-only reproduction of the observed HTTP-200/null RPC failure. */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
const browser = await chromium.launch({channel:'chrome',headless:true});
try {
    const page = await browser.newPage();
    let empty = 0, recovered = 0;
    page.on('response', response => {if(new URL(response.url()).hostname === 'unichain-sepolia-rpc.publicnode.com' && response.status() === 200) recovered++;});
    await page.route('https://sepolia.unichain.org/**', async route => {
        const payload = route.request().postDataJSON();
        if(payload?.method === 'eth_call') {
            empty++;
            await route.fulfill({json:{jsonrpc:'2.0',id:payload.id,result:null}});
        } else await route.continue();
    });
    await page.goto(process.env.PHINARY_DEV_URL ?? 'http://localhost:3113');
    await page.locator('a[href^="/market/"]').first().waitFor({timeout:45000});
    assert.ok(empty > 0 && recovered > 0);
    assert.equal(await page.getByRole('status').filter({hasText:'Reconnecting · trading paused'}).count(),0);
    await page.locator('a[href^="/market/"]').first().click();
    await page.locator('.detail-trade').waitFor({timeout:45000});
    assert.equal(await page.getByRole('status').filter({hasText:'Reconnecting · trading paused'}).count(),0);
    assert.equal(await page.locator('.detail-error').count(),0);
    console.log(`PASS HTTP-200/null recovered through independent RPC: ${empty} empty reads, ${recovered} successful backup responses; list and detail remain visible`);
} finally {await browser.close();}
