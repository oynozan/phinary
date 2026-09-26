// Repeats the app.uniswap.org check over several live markets. Every Trading API answer for our token is paired with
// an on-chain V4Quoter quote taken at the same moment. Also replays /quote from the page with V4-hooks-only routing.
// Read-only: no wallet, no transactions.
const { createRequire } = require('module')
const fs = require('fs')
const path = require('path')
const appRequire = createRequire('/Users/oynozan/Desktop/Dev/Web3/UniswapPrediction/app/package.json')
const puppeteer = appRequire('puppeteer-core')
const { createPublicClient, http, parseAbi, encodeFunctionData, decodeFunctionResult } = appRequire('viem')

const OUT = __dirname
const HOOK = '0x62bBCbA51cbFC8D0C932e482bD8F62590fEeeAa8'
const USDC = '0x31d0220469e10c4E71834a79b1f276d740d3768F'
const QUOTER = '0x56DCD40A3F2d466F48e7F48bDBE5Cc9B92Ae4472'
const APP = 'https://app.uniswap.org'
const ROUNDS = 3

const pub = createPublicClient({ transport: http('https://sepolia.unichain.org') })
const hookAbi = parseAbi([
  'function marketCount() view returns (uint256)',
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'function poolKeys(uint256) view returns (PoolKey yesKey, PoolKey noKey)',
  'struct Quote { bool tradable; uint256 tau; uint256 varE36; int256 xWad; uint256 midYes; uint256 askYes; uint256 bidYes; uint256 askNo; uint256 bidNo; }',
  'function quote(uint256) view returns (Quote)',
])
const quoterAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const lower = (a) => a.toLowerCase()

async function liveMarket(minTau = 40n) {
  for (let i = 0; i < 60; i++) {
    const id = await pub.readContract({ address: HOOK, abi: hookAbi, functionName: 'marketCount' })
    const q = await pub.readContract({ address: HOOK, abi: hookAbi, functionName: 'quote', args: [id] })
    if (q.tradable && q.tau > minTau) {
      const [yesKey] = await pub.readContract({ address: HOOK, abi: hookAbi, functionName: 'poolKeys', args: [id] })
      const yes = lower(yesKey.currency0) === lower(USDC) ? yesKey.currency1 : yesKey.currency0
      return { id, yes, yesKey }
    }
    await sleep(2000)
  }
  throw new Error('no tradable market found')
}

async function onchain(m) {
  const t = Date.now()
  const zeroForOne = lower(m.yesKey.currency0) === lower(USDC)
  const data = encodeFunctionData({
    abi: quoterAbi,
    functionName: 'quoteExactInputSingle',
    args: [{ poolKey: m.yesKey, zeroForOne, exactAmount: 1_000_000n, hookData: '0x' }],
  })
  try {
    const { data: ret } = await pub.call({ to: QUOTER, data })
    const [out] = decodeFunctionResult({ abi: quoterAbi, functionName: 'quoteExactInputSingle', data: ret })
    return { ok: true, upOutFor1Usdc: (Number(out) / 1e6).toFixed(4), ms: Date.now() - t }
  } catch (e) {
    const q = await pub.readContract({ address: HOOK, abi: hookAbi, functionName: 'quote', args: [m.id] })
    return { ok: false, error: String(e.shortMessage || e).slice(0, 120), tradable: q.tradable, tau: String(q.tau), midUp: (Number(q.midYes) / 1e18).toFixed(3) }
  }
}

async function run() {
  const result = { startedAt: new Date().toISOString(), rounds: [], replayControl: null }
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-sandbox'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1400, height: 1000 })
  await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'))

  let quoteHeaders = null
  let current = null
  page.on('request', (req) => {
    if (req.url().endsWith('/quote') && req.method() === 'POST') quoteHeaders = req.headers()
  })
  page.on('response', async (resp) => {
    const cur = current
    if (!cur || !resp.url().endsWith('/quote') || resp.request().method() !== 'POST') return
    let body = ''
    try {
      body = await resp.text()
    } catch {}
    const reqBody = JSON.parse(resp.request().postData() || '{}')
    if (lower(reqBody.tokenOut || '') !== lower(cur.m.yes)) return
    const oc = await onchain(cur.m)
    let summary = body.slice(0, 160)
    try {
      const j = JSON.parse(body)
      summary = j.errorCode ? `${j.errorCode}: ${j.detail}` : `routing=${j.routing}`
    } catch {}
    cur.app.push({ status: resp.status(), kind: reqBody.routingPreference ? 'routingPreference=' + reqBody.routingPreference : 'protocols=' + (reqBody.protocols || []).join('+'), answer: summary, onchainSameMoment: oc })
  })

  await page.goto(`${APP}/swap`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  let persistKey
  for (let i = 0; i < 60 && !persistKey; i++) {
    await sleep(1000)
    persistKey = (await page.evaluate(() => Object.keys(localStorage))).find((k) => k.includes('persist:interface'))
  }
  if (!persistKey) throw new Error('app never created its persisted state')
  await sleep(3000)
  await page.evaluate((key) => {
    const s = JSON.parse(localStorage.getItem(key))
    const us = typeof s.userSettings === 'string' ? JSON.parse(s.userSettings) : s.userSettings || {}
    us.isTestnetModeEnabled = true
    s.userSettings = typeof s.userSettings === 'string' ? JSON.stringify(us) : us
    localStorage.setItem(key, JSON.stringify(s))
  }, persistKey)

  const replay = (body) =>
    page.evaluate(
      async ({ body, headers }) => {
        const h = { 'content-type': 'application/json' }
        for (const [k, v] of Object.entries(headers || {})) if (k.startsWith('x-')) h[k] = v
        const r = await fetch('https://entry-gateway.backend-prod.api.uniswap.org/quote', { method: 'POST', credentials: 'include', headers: h, body: JSON.stringify(body) })
        const t = await r.text()
        let s = t.slice(0, 160)
        try {
          const j = JSON.parse(t)
          s = j.errorCode ? `${j.errorCode}: ${j.detail}` : `routing=${j.routing}, route=${JSON.stringify(j.quote?.route?.[0]?.map((p) => p.type))}`
        } catch {}
        return { status: r.status, answer: s }
      },
      { body, headers: quoteHeaders },
    )
  const v4Only = (tokenIn, tokenOut, amount) => ({
    type: 'EXACT_INPUT', amount, tokenInChainId: 1301, tokenOutChainId: 1301, tokenIn, tokenOut,
    swapper: '0xAAAA44272dc658575Ba38f43C438447dDED45358', protocols: ['V4'], hooksOptions: 'V4_HOOKS_ONLY', slippageTolerance: 2.5,
  })
  const inclusive = (tokenIn, tokenOut, amount) => ({ ...v4Only(tokenIn, tokenOut, amount), protocols: ['V4', 'V3', 'V2'], hooksOptions: 'V4_HOOKS_INCLUSIVE' })

  for (let r = 0; r < ROUNDS; r++) {
    const m = await liveMarket()
    current = { m, app: [] }
    const round = { marketId: String(m.id), upToken: m.yes, onchainAtStart: await onchain(m) }
    await page.goto(`${APP}/swap?chain=unichain_sepolia&inputCurrency=${USDC}&outputCurrency=${m.yes}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
    await sleep(8000)
    try {
      const input = (await page.$$('input[inputmode="decimal"]'))[0]
      await input.click({ clickCount: 3 })
      await input.type('1', { delay: 60 })
    } catch (e) {
      round.typeError = String(e).slice(0, 150)
    }
    await sleep(12000)
    round.appUiBuyBox = (await page.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').match(/Buy \| [^|]* \|[^|]*\|[^|]*/)?.[0] || null
    round.app = current.app
    if (quoteHeaders) {
      round.replayV4HooksOnly = { ...(await replay(v4Only(USDC, m.yes, '1000000'))), onchainSameMoment: await onchain(m) }
      round.replayV4V3V2Inclusive = { ...(await replay(inclusive(USDC, m.yes, '1000000'))), onchainSameMoment: await onchain(m) }
    }
    await page.screenshot({ path: path.join(OUT, `round${r + 1}.png`) })
    result.rounds.push(round)
    current = null
  }
  if (quoteHeaders) {
    result.replayControl = {
      ethToUsdcInclusive: await replay(inclusive('0x0000000000000000000000000000000000000000', USDC, '1000000000000000')),
      ethToUsdcV4HooksOnly: await replay(v4Only('0x0000000000000000000000000000000000000000', USDC, '1000000000000000')),
    }
  }
  result.finishedAt = new Date().toISOString()
  fs.writeFileSync(path.join(OUT, 'result2.json'), JSON.stringify(result, null, 1))
  await browser.close()
  console.log(JSON.stringify(result, null, 1))
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
