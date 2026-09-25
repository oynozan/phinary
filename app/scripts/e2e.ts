/**
 * Browser end-to-end check of the backup page against a running local stack (scripts/local-stack.ts) and dev server.
 *
 * Drives headless Chrome through the whole market lifecycle: connect (burner wallet, or a mock injected EIP-1193
 * wallet that signs with a local key), fund on the fork, buy YES with the ERC20 approve + Permit2 signature + swap flow,
 * sell half with only a signature, buy NO, wait for the cutoff and settlement ("Settle now" if the keeper has not),
 * then redeem the winner half through a UniversalRouter swap and the rest with hook.redeem().
 *
 *   APP_URL=http://localhost:5746/ RPC_URL=http://127.0.0.1:8746 node scripts/e2e.ts [--wallet=burner|injected]
 */
import puppeteer, { type Page } from 'puppeteer-core'
import { createWalletClient, type Hex, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const appUrl = process.env['APP_URL'] ?? 'http://localhost:5173/'
const rpcUrl = process.env['RPC_URL'] ?? 'http://127.0.0.1:8746'
const chrome = process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const walletMode = process.argv.find((a) => a.startsWith('--wallet='))?.split('=')[1] ?? 'burner'
const shots = process.env['E2E_SCREENSHOTS']
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const failures: string[] = []
function check(ok: boolean, what: string) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) {
    failures.push(what)
  }
}

async function installMockWallet(page: Page): Promise<string[]> {
  const account = privateKeyToAccount(generatePrivateKey())
  const chain = {
    id: 1301,
    name: 'fork',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  }
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) })
  const methods: string[] = []
  await page.exposeFunction('__mockRpc', async (method: string, params: unknown[]) => {
    methods.push(method)
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [account.address]
      case 'eth_chainId':
        return '0x515'
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain':
        return null
      case 'eth_sendTransaction': {
        const tx = params[0] as { to: Hex; data: Hex; value?: Hex; gas?: Hex }
        return wallet.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : 0n,
          gas: tx.gas ? BigInt(tx.gas) : undefined,
        })
      }
      case 'eth_signTypedData_v4': {
        const typed = JSON.parse(params[1] as string) as {
          domain: Record<string, unknown>
          types: Record<string, { name: string; type: string }[]>
          primaryType: string
          message: Record<string, unknown>
        }
        const { EIP712Domain: _, ...types } = typed.types
        return account.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message: typed.message })
      }
      default: {
        const r = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? [] }),
        })
        const j = (await r.json()) as { result?: unknown; error?: { message: string } }
        if (j.error) {
          throw new Error(j.error.message)
        }
        return j.result
      }
    }
  })
  await page.evaluateOnNewDocument(() => {
    const w = window as unknown as { ethereum: unknown; __mockRpc: (m: string, p: unknown) => Promise<unknown> }
    w.ethereum = {
      isMetaMask: true,
      request: ({ method, params }: { method: string; params?: unknown }) => w.__mockRpc(method, params ?? []),
      on() {},
      removeListener() {},
    }
  })
  return methods
}

async function main() {
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1100 })
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') {
      errors.push(m.text())
    }
  })
  page.on('pageerror', (e) => errors.push(e instanceof Error ? e.message : String(e)))
  const methods = walletMode === 'injected' ? await installMockWallet(page) : undefined

  const click = async (selector: string, text: string) => {
    const ok = await page.evaluate(
      (sel, t) => {
        const el = [...document.querySelectorAll<HTMLButtonElement>(sel)].find(
          (e) => (e.textContent ?? '').trim().startsWith(t) && !e.disabled,
        )
        el?.click()
        return !!el
      },
      selector,
      text,
    )
    if (!ok) {
      throw new Error(`nothing clickable: ${selector} "${text}"`)
    }
  }
  const waitText = (t: string, timeout = 60_000) =>
    page.waitForFunction((x) => document.body.innerText.includes(x), { timeout, polling: 250 }, t)
  const waitResult = async (re: string, timeout = 90_000) => {
    await page.waitForFunction(
      (r) => new RegExp(r, 'i').test(document.querySelector('.notice.success, .notice.error')?.textContent ?? ''),
      { timeout, polling: 250 },
      re,
    )
    return page.$eval('.notice.success, .notice.error', (e) => ({
      ok: e.classList.contains('success'),
      text: (e as HTMLElement).innerText,
    }))
  }
  const secondsToCutoff = () =>
    page.evaluate(() => {
      const el = [...document.querySelectorAll('.countdown-label')].find((e) => e.textContent?.includes('Trading closes in'))
      const [m = 0, s = 0] = (el?.nextElementSibling?.textContent ?? '').split(':').map(Number)
      return el ? m * 60 + s : -1
    })
  const steps = () => page.$eval('.steps', (e) => (e as HTMLElement).innerText.replace(/\n/g, ' | ')).catch(() => '')
  const buy = async (side: 'YES' | 'NO', preset: string) => {
    await click('.tab', 'Buy')
    await click('.outcome', side)
    await click('button', preset)
    await page.waitForFunction(
      (s) => new RegExp(`\\d ${s}`).test(document.querySelector('.summary .big')?.textContent ?? ''),
      { timeout: 20_000 },
      side,
    )
    await click('.btn-lg', `Buy ${side}`)
    const r = await waitResult('Bought|failed|Rejected|revert|slippage|closed')
    check(r.ok, `buy ${side}: ${r.text}`)
    return steps()
  }

  await page.goto(appUrl, { waitUntil: 'networkidle2' })
  await waitText('Market #')
  check(true, 'page loaded and shows a market')
  check((await page.$eval('#market-question', (e) => e.textContent ?? '')).match(/^ETH above \$[\d,]+\.\d\d at \d\d:\d\d:\d\d\?$/) !== null, 'question text format')

  if (walletMode === 'injected') {
    await click('button', 'Connect wallet')
    await sleep(300)
    if (await page.$('.menu')) {
      await click('.menu-item', 'MetaMask')
    }
  } else {
    await page.evaluate(() => {
      const d = document.querySelector<HTMLDetailsElement>('details.dev')
      if (d) {
        d.open = true
      }
    })
    await click('button', 'New burner')
  }
  await page.waitForSelector('.header button .mono', { timeout: 20_000 })
  await page.evaluate(() => {
    const d = document.querySelector<HTMLDetailsElement>('details.dev')
    if (d) {
      d.open = true
    }
  })
  await click('button', 'Fund 10 ETH')
  await waitText('Funded 10 ETH and 1,000 USDC')
  check(true, 'funded on the fork')

  for (;;) {
    const s = await secondsToCutoff()
    if (s >= 25) {
      break
    }
    if (s < 0) {
      await page.evaluate(() =>
        [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Go to live market'))?.click(),
      )
    }
    await sleep(1000)
  }
  const market = await page.$eval('.mv-eyebrow', (e) => (e as HTMLElement).innerText.match(/Market #(\d+)/)?.[1])

  const firstBuy = await buy('YES', '$2')
  check(/✓ \| Allow Permit2 to use USDC/.test(firstBuy) && /✓ \| Sign Permit2/.test(firstBuy), 'first buy: approve + permit + swap')
  if (shots) {
    await page.screenshot({ path: `${shots}/e2e-bought.png`, fullPage: true })
  }

  await click('.tab', 'Sell')
  await click('.outcome', 'YES')
  await sleep(1500)
  await click('button', '50%')
  await page.waitForFunction(() => /\d USDC/.test(document.querySelector('.summary .big')?.textContent ?? ''), { timeout: 20_000 })
  await click('.btn-lg', 'Sell YES')
  const sell = await waitResult('Sold|failed|Rejected|revert|slippage|closed')
  check(sell.ok, `sell YES: ${sell.text}`)
  const sellSteps = await steps()
  check(/Outcome tokens pre-approve Permit2/.test(sellSteps), 'sell needs no ERC20 approval')

  if ((await secondsToCutoff()) >= 6) {
    await buy('NO', '$1')
  }

  await page.waitForFunction(() => document.body.innerText.includes('Trading closed'), { timeout: 70_000 })
  check(true, 'trading closes at the cutoff')
  await page.waitForFunction(
    () =>
      /won/.test(document.querySelector('.winner-banner')?.textContent ?? '') ||
      [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Settle now')),
    { timeout: 90_000, polling: 500 },
  )
  if (await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('Settle now')))) {
    await click('.btn-lg', 'Settle now')
    const r = await waitResult('settled|failed|Rejected|revert|MarketClosed')
    check(r.ok || /closed/i.test(r.text), `settle now: ${r.text}`)
  }
  await page.waitForFunction(() => /won/.test(document.querySelector('.winner-banner')?.textContent ?? ''), { timeout: 60_000 })
  const banner = await page.$eval('.winner-banner', (e) => (e as HTMLElement).innerText.split('\n')[1] ?? '')
  check(true, `market #${market} settled: ${banner}`)
  if (shots) {
    await page.screenshot({ path: `${shots}/e2e-settled.png`, fullPage: true })
  }

  if (await page.evaluate(() => document.body.innerText.includes('Redeem via Uniswap swap'))) {
    const max = await page.$eval('.field-top .btn-link', (e) => (e.textContent ?? '').replace('Max ', ''))
    const half = (Number(max.replace(/,/g, '')) / 2).toFixed(2)
    await page.type('#redeem-amount', half)
    await click('.btn-lg', 'Redeem via Uniswap swap')
    const r1 = await waitResult('Redeemed|failed|Rejected|revert')
    check(r1.ok && r1.text.includes(`Redeemed ${half}`), `redeem via swap at $1.00: ${r1.text}`)
    await sleep(2500)
    await click('button', 'Redeem directly')
    const r2 = await waitResult('Redeemed .* hook.redeem|failed|Rejected|revert')
    check(r2.ok, `redeem with hook.redeem(): ${r2.text}`)
  } else {
    check(true, 'no winning tokens left to redeem')
  }

  const activity = await page.$$eval('.activity li', (els) => els.length)
  check(activity >= 3, `activity lists ${activity} transactions`)
  if (methods) {
    const used = [...new Set(methods)]
    check(used.includes('eth_signTypedData_v4') && used.includes('eth_sendTransaction'), `wallet methods: ${used.join(',')}`)
  }
  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' / ')}` : ''}`)
  await browser.close()
  if (failures.length) {
    console.error(`${failures.length} check(s) failed`)
    process.exit(1)
  }
  console.log('all checks passed')
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
