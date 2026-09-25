import puppeteer from 'puppeteer-core'
const url = 'http://localhost:3000/swap?chain=unichain_sepolia&inputCurrency=0x31d0220469e10c4E71834a79b1f276d740d3768F&outputCurrency=0x416A506124D0b654203B6E396030BAb1D46169FC'
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900 })
const logs = []
page.on('console', (m) => { const t = m.text(); if (/predict|quote|error/i.test(t)) logs.push(m.type() + ': ' + t.slice(0, 200)) })
await page.evaluateOnNewDocument(() => { try { localStorage.setItem('testnetMode', 'true') } catch {} })
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise((r) => setTimeout(r, 20000))
await page.screenshot({ path: '../deployments/.run/shots/fork-1-loaded.png' })
const inputs = await page.$$('input[inputmode="decimal"], input[type="text"]')
console.log('inputs found', inputs.length)
if (inputs.length) { await inputs[0].click(); await inputs[0].type('1', { delay: 50 }) }
await new Promise((r) => setTimeout(r, 8000))
await page.screenshot({ path: '../deployments/.run/shots/fork-2-quoted.png' })
const vals = await page.$$eval('input', (els) => els.map((e) => e.value).filter(Boolean))
console.log('input values', JSON.stringify(vals))
const text = await page.evaluate(() => document.body.innerText.slice(0, 1500))
console.log(text.replace(/\n+/g, ' | '))
console.log(logs.slice(-15).join('\n'))
await browser.close()
