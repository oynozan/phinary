import puppeteer from 'puppeteer-core'
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 1000 })
await page.goto('http://localhost:3000/swap', { waitUntil: 'domcontentloaded', timeout: 90000 })
await new Promise((r) => setTimeout(r, 15000))
const clicked = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button, [role="button"], div')].filter((b) => b.textContent?.trim() === 'Select token')
  const target = btns[btns.length - 1]
  if (!target) return false
  target.click()
  return true
})
console.log('clicked Select token:', clicked)
await new Promise((r) => setTimeout(r, 12000))
await page.screenshot({ path: '../deployments/.run/shots/fork-picker.png' })
const txt = await page.evaluate(() => document.body.innerText)
const i = txt.indexOf('Prediction markets')
console.log(i >= 0 ? 'FOUND section: ' + txt.slice(i, i + 400).replace(/\n+/g, ' | ') : 'section NOT found; picker text: ' + txt.slice(0, 600).replace(/\n+/g, ' | '))
await browser.close()
