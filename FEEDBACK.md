# Uniswap feedback from the Phinary team

We built Phinary at ETHGlobal Tokyo 2026: binary prediction markets that trade through a Uniswap v4 hook on Unichain Sepolia. The hook calculates the price, traders swap through UniversalRouter, and a shared USDC vault backs the outcomes. We also built a TypeScript swap SDK, a dashboard, and an integration with a local fork of the Uniswap interface.

The part we liked most was being able to change the pricing model while still using v4 swaps. That is what made this project worth building on Uniswap. Our feedback is mostly about what happens after the hook works: helping someone find it, integrate it, and understand why a transaction failed.

## Finding a hook should not start with a JSON file

Our biggest request is an official, browsable place where a builder can explain a hook and someone else can find its deployment address.

There is already a [Uniswap hooklist](https://github.com/Uniswap/hooklist), with a combined JSON file and individual deployment files. The developer site also has a [Hook Discovery page](https://developers.uniswap.org/docs/community/learning/hook-discovery) linking to community directories. So the missing piece for us was not a registry from scratch. It was an official discovery experience built around that information.

Working through a large JSON list is awkward when the question is simply, “What does this hook do, and which address should I use?” For Phinary, we want to send someone to a page that explains the markets, identifies the network, and links to the right contract. They should not have to inspect a deployment file to get started.

A searchable page for each hook would help: a short description, deployments by chain, source code, hook permissions, and a working example. It should distinguish a listed hook from one reviewed for routing compatibility, and neither should look like a security endorsement. Builders could keep submitting metadata through GitHub; readers would get a page they can actually browse and share.

If we could pick one improvement, it would be this.

## Show the whole path from a custom hook to a wallet swap

For our integration, we put together pool discovery, V4Quoter calls, ERC-20 approval, Permit2, UniversalRouter calldata, simulation, and receipt handling. That work now lives in [our swap SDK](packages/swap-sdk/README.md).

We would have liked a small, runnable reference that takes a custom pricing hook through that entire flow. Include the exact router deployment and ABI, then show one successful buy and sell on a testnet. A contract-only example leaves the wallet and frontend integration as another project.

It would also help to explain routing eligibility alongside that example. Being able to execute a swap through UniversalRouter does not mean the public Uniswap app will discover the pool. The [routing allowlist form](https://developers.uniswap.org/hook-allowlist) describes a separate review process. Link that step directly from the custom-hook integration guide, so builders know what their local demo proves and what still needs to happen.

## Make nested hook errors easier to read

Our SDK decodes failures such as `UnexpectedRevertBytes -> WrappedError(hook) -> Band`. That underlying error matters: the frontend needs to distinguish a price outside the allowed band from a closed market, insufficient capacity, or a missing approval.

A reusable decoder that accepts a hook's error ABI would save work here. A few examples showing the raw revert and the decoded cause would already help. We wrote [our own decoder](packages/swap-sdk/src/errors.ts); this seems useful beyond prediction markets.

## Include bad RPC responses in the frontend examples

One bug looked like random market-loading failures. The public Sepolia RPC sometimes returned HTTP 200 with `result: null` for `eth_call`. Checking the HTTP status alone missed it. Replaying the same call at the same block returned valid data.

We added result validation and retried the same request through another RPC. In a two-minute observation, all three real empty responses recovered without a visible page error. The [investigation notes](web/docs/market-rpc-investigation.md) include the captured blocks and reproduction details.

We did not establish what caused the provider to return null, and this was not a v4 contract failure. Still, a frontend example that handles malformed successful responses, preserves the last snapshot, and blocks trading on stale quotes would have been useful during the hackathon. These failures are much easier to diagnose when the example keeps the original error instead of turning everything into “could not load.”
