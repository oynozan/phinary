const path = require('path')
const { chromium } = require(path.resolve(__dirname, '../repos/uniswap-interface/node_modules/playwright-core'))
;(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })
  const page = await (await browser.newContext()).newPage()
  await page.goto('http://localhost:3000/swap', { waitUntil: 'domcontentloaded', timeout: 180000 })
  await page.waitForTimeout(20000)
  const res = await page.evaluate(async () => {
    const base = 'https://entry-gateway.backend-dev.api.uniswap.org'
    const call = async (label, body, withCreds) => {
      const r = await fetch(base + '/quote', {
        method: 'POST',
        credentials: withCreds ? 'include' : 'omit',
        headers: { 'content-type': 'application/json', 'x-api-key': 'trading_api_key', 'x-request-source': 'uniswap-web' },
        body: JSON.stringify(body),
      })
      return { label, status: r.status, body: (await r.text()).slice(0, 400) }
    }
    const sw = '0xAAAA44272dc658575Ba38f43C438447dDED45358'
    const out = []
    const mainnet = { type: 'EXACT_INPUT', amount: '10000000000000000', tokenInChainId: 1, tokenOutChainId: 1, tokenIn: '0x0000000000000000000000000000000000000000', tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', swapper: sw, routingPreference: 'BEST_PRICE' }
    out.push(await call('mainnet ETH->USDC, session cookie', mainnet, true))
    out.push(await call('mainnet ETH->USDC, NO cookie', mainnet, false))
    // USDC -> a token with no Uniswap pools on Unichain Sepolia (the chain's L2 WETH predeploy is routable; this address is the ETH-USDC v3 pool itself, i.e. not a token)
    out.push(await call('1301 USDC->non-routable address', { type: 'EXACT_INPUT', amount: '1000000', tokenInChainId: 1301, tokenOutChainId: 1301, tokenIn: '0x31d0220469e10c4E71834a79b1f276d740d3768F', tokenOut: '0xBeAD5792bB6C299AB11Eaa425aC3fE11ebA47b3B', swapper: sw, protocols: ['V4', 'V3', 'V2'], hooksOptions: 'V4_HOOKS_INCLUSIVE' }, true))
    return out
  })
  console.log(JSON.stringify(res, null, 1))
  await browser.close()
})().catch((e) => { console.error(e); process.exit(1) })
