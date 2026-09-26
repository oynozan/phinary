/** Read-only header backdrop regression checks against a running frontend. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const base = process.env.PHINARY_DEV_URL ?? 'http://127.0.0.1:3113';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 600 });
        for (const route of ['/', '/portfolio', '/activity', '/vault']) {
            await page.goto(base + route);
            await page.locator('main h1').waitFor();
            // Test actual scrolling; short connected-entry pages still have shell clearance.
            for (const target of [0, 48, 96, 180, 0]) {
                await page.evaluate(y => scrollTo(0, y), target);
                await page.waitForFunction(() => {
                    const header = document.querySelector('.app-header');
                    const actual = Number(getComputedStyle(header).getPropertyValue('--header-background-alpha'));
                    return Math.abs(actual - Math.min(1, Math.max(0, scrollY) / 96) * 0.96) < .001;
                });
                const state = await page.locator('.app-header').evaluate(header => ({
                    y: scrollY,
                    alpha: Number(getComputedStyle(header).getPropertyValue('--header-background-alpha')),
                    opacity: getComputedStyle(header).opacity,
                    top: header.getBoundingClientRect().top,
                }));
                assert.equal(state.opacity, '1');
                assert.equal(state.top, 0);
                if (target === 0) assert.equal(state.alpha, 0);
                if (state.y >= 96) assert.equal(state.alpha, .96);
            }
            console.log(`PASS ${width}px ${route}: transparent top, proportional backdrop, opaque controls`);
        }
    }
    await page.setViewportSize({ width: 390, height: 600 });
    await page.goto(base + '/');
    await page.evaluate(() => scrollTo(0, 180));
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('menuitem', { name: 'Vault', exact: true }).click();
    await page.waitForURL(base + '/vault');
    await page.waitForFunction(() => scrollY === 0 && Number(getComputedStyle(document.querySelector('.app-header')).getPropertyValue('--header-background-alpha')) === 0);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => scrollTo(0, 96));
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.app-header')).getPropertyValue('--header-background-alpha')) > 0);
    assert.deepEqual(errors, []);
    console.log('PASS mobile menu, route scroll reset, reduced motion and runtime errors');
} finally { await browser.close(); }
