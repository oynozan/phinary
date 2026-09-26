import puppeteer from 'puppeteer-core'
const OUT = '../docs/md/design/atomic-cash'
const base = 'http://localhost:3107'
const routes = ['/', '/pools', '/tokens', '/trades', '/portfolio']
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] })
for (const [w, h, tag] of [[1440, 900, 'desktop'], [390, 844, 'mobile']]) {
  for (const r of routes) {
    const page = await browser.newPage()
    await page.setViewport({ width: w, height: h, deviceScaleFactor: tag === 'mobile' ? 2 : 1, isMobile: tag === 'mobile' })
    try { await page.goto(base + r, { waitUntil: 'networkidle2', timeout: 60000 }) } catch (e) { console.log('nav', r, String(e).slice(0, 80)) }
    await new Promise((res) => setTimeout(res, 5000))
    const name = (r === '/' ? 'swap' : r.slice(1)) + '-' + tag + '.png'
    await page.screenshot({ path: `${OUT}/${name}`, fullPage: tag === 'desktop' })
    console.log('saved', name)
    await page.close()
  }
}
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
await page.goto(base + '/', { waitUntil: 'networkidle2', timeout: 60000 })
await new Promise((res) => setTimeout(res, 3000))
const info = await page.evaluate(() => {
  const cs = (el) => { const s = getComputedStyle(el); return { font: s.fontFamily.slice(0, 40), size: s.fontSize, weight: s.fontWeight, color: s.color, bg: s.backgroundColor, radius: s.borderRadius, border: s.borderTopColor, shadow: s.boxShadow.slice(0, 80), pad: s.padding } }
  const out = {}
  for (const sel of ['header > div', 'header a', 'h1', 'h2', 'button', 'input', '[class*=rounded-3xl]', '[class*=rounded-2xl]', '[class*=card]']) {
    out[sel] = [...document.querySelectorAll(sel)].slice(0, 4).map((el) => ({ text: (el.innerText || '').trim().slice(0, 30), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height), ...cs(el) }))
  }
  return out
})
console.log(JSON.stringify(info, null, 1).slice(0, 5000))
await browser.close()
