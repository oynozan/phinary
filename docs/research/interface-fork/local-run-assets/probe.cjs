// Headless probe of the local Uniswap interface dev server.
// Usage: node probe.cjs <url> <outPrefix> [amount]
const path = require('path')
const fs = require('fs')
const { chromium } = require(path.resolve(__dirname, '../repos/uniswap-interface/node_modules/playwright-core'))

const url = process.argv[2]
const out = process.argv[3]
const amount = process.argv[4]

;(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  })
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const page = await ctx.newPage()
  const reqs = []
  const consoleErrs = []
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') consoleErrs.push(`[${m.type()}] ${m.text().slice(0, 400)}`)
  })
  page.on('pageerror', (e) => consoleErrs.push(`[pageerror] ${String(e).slice(0, 400)}`))
  page.on('requestfinished', async (r) => {
    const u = r.url()
    if (u.startsWith('http://localhost:3000/') && !u.includes('/entry-gateway') && !u.includes('/config/')) return
    let status = null
    let body = ''
    try {
      const resp = await r.response()
      status = resp ? resp.status() : null
      if (resp && /quote|swap|graphql|entry-gateway|trade|config|statsig|data-api|v2|v1/.test(u)) {
        body = (await resp.text()).slice(0, 300)
      }
    } catch {}
    reqs.push({ m: r.method(), u: u.slice(0, 250), status, body, reqHeaders: pickHeaders(r.headers()) })
  })
  page.on('requestfailed', (r) => {
    reqs.push({ m: r.method(), u: r.url().slice(0, 250), status: 'FAILED', body: r.failure()?.errorText })
  })
  function pickHeaders(h) {
    const o = {}
    for (const k of ['x-api-key', 'origin', 'x-request-source', 'x-universal-router-version', 'x-app-version']) if (h[k]) o[k] = h[k]
    return o
  }

  const t0 = Date.now()
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 })
  await page.waitForTimeout(25000)
  await page.screenshot({ path: `${out}-loaded.png` })
  const loadedMs = Date.now() - t0

  if (amount) {
    try {
      const input = page.locator('input[inputmode="decimal"]').first()
      await input.click({ timeout: 10000 })
      await input.fill(amount)
      await page.waitForTimeout(15000)
      await page.screenshot({ path: `${out}-quoted.png` })
    } catch (e) {
      consoleErrs.push(`[probe] could not type amount: ${e}`)
    }
  }
  const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 3000)
  fs.writeFileSync(`${out}.json`, JSON.stringify({ url, loadedMs, reqs, consoleErrs, text }, null, 1))
  await browser.close()
  console.log('done', url, 'requests', reqs.length, 'consoleErrs', consoleErrs.length)
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
