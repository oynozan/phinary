import {
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { poolManagerAbi } from "./abi.ts";
import { rpcUrlList, type CommonConfig } from "./config.ts";
import { decodeSlot0, poolId, poolStateSlot, type PoolKey, type Slot0 } from "./pricing.ts";

export interface Clients {
  chain: Chain;
  publicClient: PublicClient<Transport, Chain>;
  walletClient?: WalletClient<Transport, Chain, Account>;
  account?: Account;
}

export function makeClients(cfg: Pick<CommonConfig, "rpcUrl" | "chainId" | "privateKey">): Clients {
  const urls = rpcUrlList(cfg.rpcUrl);
  if (urls.length === 0) throw new Error("RPC_URL is empty");
  const chain = defineChain({
    id: cfg.chainId,
    name: cfg.chainId === 1301 ? "Unichain Sepolia" : `chain-${cfg.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: urls } },
  });
  // Several URLs: each request goes to the first that answers, so a rate-limited primary falls through to the next.
  const transports = urls.map((url) => http(url, { retryCount: 2, timeout: 15_000 }));
  const transport: Transport = transports.length === 1 ? transports[0]! : fallback(transports);
  const publicClient = createPublicClient({ chain, transport, pollingInterval: 500 });
  if (!cfg.privateKey) return { chain, publicClient };
  const account = privateKeyToAccount(cfg.privateKey.key);
  const walletClient = createWalletClient({ chain, transport, account });
  return { chain, publicClient, walletClient, account };
}

export async function assertChainId(publicClient: PublicClient, expected: number): Promise<void> {
  const actual = await publicClient.getChainId();
  if (actual !== expected) throw new Error(`RPC is on chain ${actual}, expected ${expected}`);
}

export async function readSlot0(publicClient: PublicClient, poolManager: Address, key: PoolKey): Promise<Slot0> {
  const word = await publicClient.readContract({
    address: poolManager,
    abi: poolManagerAbi,
    functionName: "extsload",
    args: [poolStateSlot(poolId(key))],
  });
  return decodeSlot0(word);
}

export async function waitForSuccess(
  publicClient: PublicClient,
  hash: Hash,
  timeoutMs: number,
): Promise<TransactionReceipt> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs });
  if (receipt.status !== "success") throw new Error(`transaction ${hash} reverted`);
  return receipt;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** AbortSignal that fires on SIGINT/SIGTERM so loops can finish their current iteration. */
export function shutdownSignal(onStop: (sig: string) => void): AbortSignal {
  const ctrl = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      onStop(sig);
      ctrl.abort();
    });
  }
  return ctrl.signal;
}
