import {
  type Address,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  keccak256,
  numberToHex,
  pad,
  parseAbi,
  type PublicClient,
  type TestClient,
} from 'viem'

const mintAbi = parseAbi(['function mint(address to, uint256 amount)'])

export async function fundEth(test: TestClient<'anvil'>, address: Address, wei: bigint): Promise<void> {
  await test.setBalance({ address, value: wei })
}

function balanceSlot(holder: Address, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, slot]))
}

/** Anvil "deal": finds the token's balance mapping slot by probing and writes `amount` to it. */
export async function dealErc20(
  pub: PublicClient,
  test: TestClient<'anvil'>,
  token: Address,
  holder: Address,
  amount: bigint,
): Promise<void> {
  const balanceOf = () => pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] })
  const value = pad(numberToHex(amount), { size: 32 })
  for (let slot = 0n; slot < 64n; slot++) {
    const key = balanceSlot(holder, slot)
    const before = await pub.getStorageAt({ address: token, slot: key })
    await test.setStorageAt({ address: token, index: key, value })
    if ((await balanceOf()) === amount) {
      return
    }
    await test.setStorageAt({ address: token, index: key, value: before ?? pad('0x0', { size: 32 }) })
  }
  // Mock tokens with an open mint
  await test.impersonateAccount({ address: holder })
  try {
    const hash = await test.sendUnsignedTransaction({
      from: holder,
      to: token,
      data: encodeFunctionData({ abi: mintAbi, functionName: 'mint', args: [holder, amount] }),
    })
    await pub.waitForTransactionReceipt({ hash })
  } finally {
    await test.stopImpersonatingAccount({ address: holder })
  }
  if ((await balanceOf()) < amount) {
    throw new Error('Could not fund this token on the local fork')
  }
}
