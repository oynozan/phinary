import puppeteer from 'puppeteer-core'
const [url, out, w = '1440', h = '900'] = process.argv.slice(2)
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(String(e).slice(0, 160)))
await page.setViewport({ width: +w, height: +h })
await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 })
await new Promise((r) => setTimeout(r, 4000))
await page.screenshot({ path: out })
console.log('page errors:', errs.length ? errs : 'none')
await browser.close()
