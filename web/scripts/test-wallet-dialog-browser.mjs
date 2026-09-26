/** Real Privy SDK with a local EIP-6963 fixture. Never signs or sends transactions. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
const base = process.env.PHINARY_DEV_URL ?? 'http://localhost:3113';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const evidence = '.review/wallet-dialog';
await mkdir(evidence, { recursive: true });
try {
 const page = await browser.newPage();
 const errors = [];
 page.on('pageerror', error => errors.push(error.message));
 await page.addInitScript(() => {
    window.walletRequests = 0;
    let connected = sessionStorage.getItem('fixture.wallet') === 'connected';
    let account = '0x1111111111111111111111111111111111111111';
    const listeners = new Map();
    const provider = {
      isMetaMask: true,
      on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]); },
      removeListener(event, fn) { listeners.set(event, (listeners.get(event) ?? []).filter(x => x !== fn)); },
      async request({method}) {

        if (method === 'eth_chainId') return '0x515';
        if (method === 'eth_accounts') return connected ? [account] : [];
        if (method === 'wallet_getPermissions') return [];
        if (method === 'wallet_requestPermissions') {
          window.walletRequests++; connected = true; sessionStorage.setItem('fixture.wallet','connected');
          return [{ parentCapability: 'eth_accounts', caveats: [{type:'restrictReturnedAccounts',value:['0x1111111111111111111111111111111111111111']}] }];
        }
        if (method === 'eth_requestAccounts') {
          window.walletRequests++;
          connected = true; sessionStorage.setItem('fixture.wallet','connected');
          return ['0x1111111111111111111111111111111111111111'];
        }
        if (method === 'wallet_revokePermissions') { connected = false; sessionStorage.removeItem('fixture.wallet'); return null; }
        throw new Error('Unexpected fixture method: ' + method);
      }
    };
    window.changeFixtureAccount = () => { account = '0x2222222222222222222222222222222222222222'; for (const fn of listeners.get('accountsChanged') ?? []) fn([account]); };
    window.ethereum = provider;
    window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', {detail:{
      info: {uuid:'350670db-19fa-4704-a166-e52e178b59d2',rdns:'io.metamask',name:'MetaMask',icon:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>'},provider
    }})));
 });
 for (const width of [390,1440]) {
   await page.setViewportSize({width,height:900});
   await page.goto(base + '/vault');
   await page.locator('.header-wallet').click();
   const dialog=page.locator('#privy-dialog');
   await dialog.locator('[id^="headlessui-dialog-panel"]').waitFor();
   await page.locator('.phinary-privy-intro').waitFor();
   assert.equal(await page.locator('[role=dialog]').count(),1);
   assert.equal(await page.locator('.wallet-dialog').count(),0);
   await page.getByRole('button',{name:'MetaMask',exact:true}).waitFor();
   const bounds=await dialog.locator('[id^="headlessui-dialog-panel"]').boundingBox();
   assert.ok(bounds.x>=0 && bounds.x+bounds.width<=width);
   await page.screenshot({animations:'disabled',path:`${evidence}/${width}.png`});
   await page.keyboard.press('Escape');
   await dialog.waitFor({state:'hidden'});
 }
 await page.locator('.header-wallet').click();
 await page.getByRole('button',{name:'MetaMask',exact:true}).click();
 await page.locator('.wallet-address').waitFor({timeout:20000}).catch(async error => { console.log((await page.locator('body').innerText()).slice(-1400)); throw error; });
 assert.match(await page.locator('.wallet-address').innerText(),/1111/);
 assert.ok(await page.evaluate(()=>window.walletRequests) >= 1);
 await page.reload();
 await page.locator('.wallet-address').waitFor({timeout:30000});
 await page.evaluate(() => window.changeFixtureAccount());
 await page.waitForFunction(() => document.querySelector('.wallet-address')?.textContent.includes('2222'));
 await page.locator('.header-wallet').click();
 await page.getByRole('menuitem',{name:'Disconnect',exact:true}).click();
 await page.locator('.header-wallet').filter({hasText:'Connect wallet'}).waitFor();
 const empty=await browser.newPage({viewport:{width:320,height:640}});
 await empty.goto(base + '/portfolio');
 await empty.locator('.header-wallet').click();
 await empty.getByRole('button',{name:'MetaMask',exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 console.log('PASS responsive branding, real Privy connection with fixture account, session restoration, account changes, disconnect, no-extension entry');
} finally {await browser.close();}
