import {
  type Abi,
  type Address,
  type Client,
  createClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  type Hex,
  parseAbi,
  RpcRequestError,
} from 'viem'
import { unichainSepolia } from 'viem/chains'

/** Thrown by a mock handler to make the eth_call revert with `data`. */
export class Revert {
  readonly data: Hex
  constructor(data: Hex) {
    this.data = data
  }
}

type Handler = (data: Hex, from?: Address) => Hex
type Impl = Record<string, (...args: never[]) => unknown>

const multicall3Abi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])

/** Decodes calldata with `abi`, runs `impl[functionName](...args)` and ABI-encodes the return value. */
export function contract(abi: Abi, impl: Impl): Handler {
  return (data) => {
    let decoded: { functionName: string; args?: readonly unknown[] }
    try {
      decoded = decodeFunctionData({ abi, data }) as typeof decoded
    } catch {
      throw new Revert('0x')
    }
    const { functionName, args } = decoded
    const fn = impl[functionName]
    if (!fn) throw new Revert('0x')
    const result = (fn as (...a: unknown[]) => unknown)(...(args ?? []))
    return encodeFunctionResult({ abi, functionName, result } as never)
  }
}

/** A viem client whose eth_call is served by in-memory contract handlers, including Multicall3.aggregate3. */
export function mockClient(
  handlers: Record<string, Handler>,
  multicall3: Address,
): { client: Client; calls: string[] } {
  const calls: string[] = []
  const table = new Map(Object.entries(handlers).map(([k, v]) => [k.toLowerCase(), v]))
  const run = (to: Address, data: Hex, from?: Address): Hex => {
    const h = table.get(to.toLowerCase())
    if (!h) throw new Revert('0x')
    return h(data, from)
  }
  table.set(
    multicall3.toLowerCase(),
    contract(multicall3Abi, {
      aggregate3: (reqs: readonly { target: Address; allowFailure: boolean; callData: Hex }[]) =>
        reqs.map((c) => {
          try {
            return { success: true, returnData: run(c.target, c.callData) }
          } catch (e) {
            if (!(e instanceof Revert) || !c.allowFailure) throw e
            return { success: false, returnData: e.data }
          }
        }),
    }),
  )
  const client = createClient({
    chain: unichainSepolia,
    transport: custom({
      async request({ method, params }: { method: string; params: unknown[] }) {
        calls.push(method)
        if (method === 'eth_chainId') return '0x515'
        if (method === 'eth_blockNumber') return '0x1'
        if (method === 'eth_call') {
          const [tx] = params as [{ to: Address; data?: Hex; input?: Hex; from?: Address }]
          try {
            return run(tx.to, (tx.data ?? tx.input) as Hex, tx.from)
          } catch (e) {
            if (e instanceof Revert) {
              throw new RpcRequestError({
                body: {},
                url: 'mock://',
                error: { code: 3, message: 'execution reverted', data: e.data },
              })
            }
            throw e
          }
        }
        throw new Error(`mock: unsupported ${method}`)
      },
    }),
  })
  return { client, calls }
}
