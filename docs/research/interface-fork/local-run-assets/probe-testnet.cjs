// Enables testnet mode through the persisted redux state, then requests a Unichain Sepolia quote.
const path = require('path')
const fs = require('fs')
const { chromium } = require(path.resolve(__dirname, '../repos/uniswap-interface/node_modules/playwright-core'))

const out = path.resolve(__dirname, 'testnet')
const USDC_UNI_SEPOLIA = '0x31d0220469e10c4E71834a79b1f276d740d3768F'

;(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  })
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const page = await ctx.newPage()
  const trading = []
  const log = []
  page.on('requestfinished', async (r) => {
    const u = r.url()
    if (!/entry-gateway|trade-api|graphql/.test(u)) return
    if (/rpc\/|SessionService|compliance|Notification|EventSubscription/.test(u)) return
    const resp = await r.response().catch(() => null)
    let body = ''
    try {
      body = resp ? await resp.text() : ''
    } catch {}
    trading.push({ m: r.method(), u, status: resp && resp.status(), reqBody: (r.postData() || '').slice(0, 1500), body: body.slice(0, 2500) })
  })
  page.on('pageerror', (e) => log.push(`[pageerror] ${String(e).slice(0, 300)}`))

  await page.goto('http://localhost:3000/swap', { waitUntil: 'domcontentloaded', timeout: 180000 })
  await page.waitForTimeout(15000)
  const keys = await page.evaluate(() => Object.keys(localStorage))
  log.push('localStorage keys: ' + JSON.stringify(keys))
  const persistKey = keys.find((k) => k.includes('persist:interface'))
  log.push('persistKey: ' + persistKey)
  if (persistKey) {
    const before = await page.evaluate((k) => localStorage.getItem(k), persistKey)
    log.push('userSettings before: ' + JSON.stringify(JSON.parse(before).userSettings))
    await page.evaluate((k) => {
      const s = JSON.parse(localStorage.getItem(k))
      s.userSettings = { ...(s.userSettings || {}), isTestnetModeEnabled: true }
      localStorage.setItem(k, JSON.stringify(s))
    }, persistKey)
  }
  await page.goto(`http://localhost:3000/swap?chain=unichain_sepolia&inputCurrency=ETH&outputCurrency=${USDC_UNI_SEPOLIA}`, {
    waitUntil: 'domcontentloaded',
    timeout: 180000,
  })
  await page.waitForTimeout(20000)
  if (persistKey) {
    const after = await page.evaluate((k) => localStorage.getItem(k), persistKey)
    log.push('userSettings after reload: ' + JSON.stringify(JSON.parse(after).userSettings))
  }
  await page.screenshot({ path: `${out}-loaded.png` })
  try {
    const input = page.locator('input[inputmode="decimal"]').first()
    await input.click({ timeout: 10000 })
    await input.fill('0.001')
    await page.waitForTimeout(15000)
  } catch (e) {
    log.push(`[probe] could not type amount: ${String(e).slice(0, 200)}`)
  }
  await page.screenshot({ path: `${out}-quoted.png` })
  const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 1500)
  fs.writeFileSync(`${out}.json`, JSON.stringify({ log, trading, text }, null, 1))
  await browser.close()
  console.log('done')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
