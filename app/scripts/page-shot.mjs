import puppeteer from 'puppeteer-core'
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 1000 })
const errs = []
page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)))
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 90000 })
await new Promise((r) => setTimeout(r, 8000))
await page.screenshot({ path: '../deployments/.run/shots/backup-live.png' })
console.log((await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 900))
console.log('page errors:', errs.length ? errs.join('\n') : 'none')
await browser.close()
