/** Read-only responsive checks. Run against an already running review server. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.PHINARY_DEV_URL ?? 'http://127.0.0.1:3113';
const market = process.env.PHINARY_DESIGN_MARKET_ID ?? '169';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
    const page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        for (const route of ['/', '/portfolio', '/activity', '/vault', `/market/${market}`]) {
            await page.goto(base + route);
            await page.locator('main h1').waitFor({ timeout: 30000 });
            await page.evaluate(() => document.fonts.ready);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${route} overflows at ${width}`);
            const dock = page.getByRole('navigation', { name: 'Dock' });
            assert.equal(await dock.isVisible(), width < 1024, `${route} dock visibility at ${width}`);
            if (width < 1024) {
                assert.equal(await dock.locator('a').count(), 4);
                const active = route.startsWith('/market/') || route === '/' ? 'Markets' : route.slice(1);
                assert.equal((await dock.locator('[aria-current="page"]').innerText()).toLowerCase(), active.toLowerCase());
                for (const link of await dock.locator('a').all()) {
                    assert.ok((await link.innerText()).trim(), 'Visible navigation label');
                    const box = await link.boundingBox();
                    assert.ok(box.width >= 44 && box.height >= 44, '44px navigation targets');
                }
                for (const selector of ['.header-wallet', '.header-menu', '.detail-quick button', '.detail-segments button', '.vault-quick button', '.vault-tabs button', '.market-controls button']) {
                    for (const control of await page.locator(selector).all()) {
                        if (await control.isVisible()) assert.ok((await control.boundingBox()).height >= 44, `${route}: ${selector} at ${width}`);
                    }
                }
                const menu = await page.locator('.header-menu').boundingBox();
                assert.ok(menu.x + menu.width <= width, `Header fits at ${width}`);
            }
            console.log(`PASS ${width}px ${route}`);
        }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + '/portfolio');
    assert.equal(await page.getByRole('region', { name: 'Portfolio summary' }).count(), 0);
    await page.locator('main').getByRole('button', { name: 'Connect wallet' }).click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    for (const [label, path] of [['Activity', '/activity'], ['Vault', '/vault'], ['Markets', '/'], ['Portfolio', '/portfolio']]) {
        const link = page.getByRole('navigation', { name: 'Dock' }).getByRole('link', { name: label });
        await link.focus();
        await page.keyboard.press('Enter');
        await page.waitForURL(base + path);
        assert.equal(await link.getAttribute('aria-current'), 'page');
    }
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    console.log('PASS keyboard navigation, active states, wallet dialog and runtime errors');
} finally { await browser.close(); }
