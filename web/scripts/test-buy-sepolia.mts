/** Dedicated disposable test wallet only. No application/user keys. */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createWalletClient, http, erc20Abi, formatUnits, verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { unichainSepolia } from 'viem/chains';
import { predictionHookAbi } from '@phinary/swap-sdk';
import { createChainClient } from '../src/lib/onchain/client.ts';
import { getConnectionConfig } from '../src/lib/onchain/config.ts';
import { executeUpBuy, fetchBuyQuote } from '../src/lib/onchain/buy.ts';
const secret = JSON.parse(readFileSync('/private/tmp/phinary-test-wallet/sepolia.json', 'utf8'));
const account = privateKeyToAccount(secret.privateKey);
assert.equal(account.address, '0x33c536F45E2139C22c9991c0882DFd1A71f78192');
const config = getConnectionConfig();
assert.equal(config.chainId, 1301);
const client = createChainClient(config);
assert.equal(await client.getChainId(), 1301);
const message = 'Phinary disposable Sepolia wallet signing verification';
assert.ok(await verifyMessage({ address: account.address, message, signature: await account.signMessage({message}) }));
const [eth, usdc] = await Promise.all([
  client.getBalance({address: account.address}),
  client.readContract({address: config.usdc, abi: erc20Abi, functionName: 'balanceOf', args:[account.address]}),
]);
console.log(JSON.stringify({address:account.address, chainId:1301, signingVerified:true, eth:formatUnits(eth,18), usdc:formatUnits(usdc,6)}));
if (process.argv.includes('--execute')) {
  assert.ok(eth > 0n, 'Fund test ETH before execution');
  assert.ok(usdc >= 100000n, 'Fund test USDC before execution');
  const count = await client.readContract({address:config.predictionHook,abi:predictionHookAbi,functionName:'marketCount'});
  const quote = await fetchBuyQuote(client,Number(count),100000n,100,account.address,config);
  const wallet = createWalletClient({account,chain:unichainSepolia,transport:http(config.rpcUrl)});
  const result = await executeUpBuy(quote, {client,wallet,account:account.address,config,
    assertReady:async()=>{assert.equal(await client.getChainId(),1301);},
    onProgress:p=>console.log(p),onPending:p=>console.log({pending:p}),
  });
  const up = await client.readContract({address:quote.token,abi:erc20Abi,functionName:'balanceOf',args:[account.address]});
  assert.ok(result.qty && result.qty >= quote.minimumOut);
  assert.ok(up >= result.qty);
  console.log(JSON.stringify({marketId:Number(count),hash:result.hash,receivedUp:formatUnits(result.qty,6),upBalance:formatUnits(up,6)}));
}
