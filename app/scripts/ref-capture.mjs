import puppeteer from 'puppeteer-core'
const OUT = '../docs/md/design/atomic-cash'
const url = process.argv[2] ?? 'https://atomic.cash'
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(String(e).slice(0, 150)))
await page.setViewport({ width: 1440, height: 900 })
await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 })
await new Promise((r) => setTimeout(r, 4000))
console.log('final url', page.url(), 'title', await page.title())
await page.screenshot({ path: `${OUT}/desktop-fold.png` })
await page.screenshot({ path: `${OUT}/desktop-full.png`, fullPage: true })
const info = await page.evaluate(() => {
  const cs = (el) => { const s = getComputedStyle(el); return { font: s.fontFamily, size: s.fontSize, weight: s.fontWeight, color: s.color, bg: s.backgroundColor, ls: s.letterSpacing, lh: s.lineHeight } }
  const pick = (sel) => [...document.querySelectorAll(sel)].slice(0, 6).map((el) => ({ tag: el.tagName, text: (el.innerText || '').trim().slice(0, 60), ...cs(el), w: el.getBoundingClientRect().width }))
  const fonts = [...document.fonts].map((f) => `${f.family} ${f.weight} ${f.status}`)
  const links = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href')).filter(Boolean).slice(0, 40)
  const colors = {}
  for (const el of document.querySelectorAll('*')) { const s = getComputedStyle(el); for (const c of [s.color, s.backgroundColor, s.borderTopColor]) if (c && c !== 'rgba(0, 0, 0, 0)') colors[c] = (colors[c] || 0) + 1 }
  const topColors = Object.entries(colors).sort((a, b) => b[1] - a[1]).slice(0, 20)
  const containers = [...document.querySelectorAll('main, section, header, nav, footer, [class*=container]')].slice(0, 12).map((el) => ({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 80), w: Math.round(el.getBoundingClientRect().width), x: Math.round(el.getBoundingClientRect().x) }))
  const radii = [...new Set([...document.querySelectorAll('button, a, input, [class*=card], [class*=Card]')].map((el) => getComputedStyle(el).borderRadius))].slice(0, 12)
  return { body: cs(document.body), h1: pick('h1'), h2: pick('h2'), h3: pick('h3'), buttons: pick('button'), p: pick('p'), fonts: [...new Set(fonts)], links, topColors, containers, radii, text: document.body.innerText.slice(0, 2500) }
})
console.log(JSON.stringify(info, null, 1))
await page.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 })
await page.reload({ waitUntil: 'networkidle2' })
await new Promise((r) => setTimeout(r, 3000))
await page.screenshot({ path: `${OUT}/mobile-full.png`, fullPage: true })
console.log('errors', errs)
await browser.close()
