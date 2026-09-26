# Phinary: binary options, traded as Uniswap swaps

Developer feedback from ETHGlobal Tokyo 2026.

Phinary brings binary options into Uniswap v4. A trader buys an UP or DOWN token with USDC. At expiry, the winning side redeems for $1 per token. Buying and selling use the same Uniswap swap infrastructure that already handles token trades.

The interesting part is inside the hook. Our [`beforeSwap` implementation](src/PredictionHook.sol#L221-L247) calculates an option price from the underlying pool price, volatility and time to expiry, then returns the swap delta. The pricing model is Black-Scholes adapted to the settlement window. A shared USDC vault supplies the backing, and settlement reads the underlying Uniswap pool's average price over that window.

That is what we wanted to explore with v4: how much of an options venue can fit inside a hook while keeping the existing swap interface? Phinary puts the option pricing and accounting there, with V4Quoter, Permit2 and UniversalRouter handling the trader's route into it. We built a [TypeScript SDK](packages/swap-sdk/README.md), a dashboard, and an integration in a local fork of the Uniswap interface around that route.

The contracts are deployed on Unichain Sepolia. One distinction matters for the demo: a bot trades our testnet underlying pools toward external reference prices because those pools do not have organic arbitrage. The contracts read the pools; they do not consume the external feed directly. Our mainnet oracle design is separate and is not deployed. Current addresses are in the [deployment file](deployments/unichain-sepolia.json).

## Give each hook a page people can find

Once the integration exists, sharing it should be straightforward. We want to send someone one link where they can see what Phinary does, which chain it runs on, and which hook address to use.

The [Uniswap hooklist](https://github.com/Uniswap/hooklist) already contains deployment metadata, and [Hook Discovery](https://developers.uniswap.org/docs/community/learning/hook-discovery) points to community catalogs. A useful next step would be an official browsing experience that brings the description, deployments, permissions, source and a working example together on a page for each hook.

For Phinary, that page could explain that a swap buys a binary option, show its expiry and settlement rules, and give an integrator a quote example. An address and a set of permission flags do not tell that story on their own.

The page should also say whether a hook is simply listed or has been reviewed for routing compatibility. Neither label should imply a security audit. This is the improvement we would put first: make a working hook easier for the next developer to find and try.

## Take the reference example all the way to the wallet

Our swap path includes pool discovery, a V4Quoter call, ERC-20 approval, Permit2, UniversalRouter calldata, simulation and receipt handling. The pieces come together in our SDK, but there is quite a bit of integration between a hook contract and a usable buy button.

A small reference app for a custom pricing hook would help. Pin the router address and ABI for a testnet, show a buy and a sell, and include the approval and failure paths. For a new builder, being able to compare one complete transaction against a known working example is more useful than another isolated code snippet.

Please put the routing review step beside that example. Phinary uses `beforeSwapReturnDelta`, and the [routing allowlist form](https://developers.uniswap.org/hook-allowlist) covers hooks using return deltas. Executing through UniversalRouter and appearing in the public Uniswap app are separate milestones. Our interface demo uses a local fork; it does not establish public routing support.

## Keep the hook's error visible

A failed quote can arrive as `UnexpectedRevertBytes -> WrappedError(hook) -> Band`. The last part is the one the trader needs. A price outside the allowed band needs a different response from a closed option, exhausted capacity or a missing approval.

We wrote a [decoder](packages/swap-sdk/src/errors.ts) that unwraps those errors and accepts additional hook error ABIs. A shared decoder, with raw revert examples and their decoded results, would be useful for other custom hooks too. The wrapper should preserve the reason the hook rejected the trade, all the way to the frontend.

## Test the response body, even when the RPC says 200

One of our loading bugs was easy to misread. The public Sepolia RPC sometimes returned HTTP 200 with `result: null` for `eth_call`. An HTTP-only check saw success. The contract decoder saw no data. Replaying the same call at the same block returned a valid result.

We added response validation and retried the identical request through another RPC. During a two-minute observation, three real empty responses recovered without a visible page error. We kept the captured blocks and reproduction details in the [investigation notes](web/docs/market-rpc-investigation.md).

We have not established why the provider returned null. This was not a v4 contract failure. It is still worth including in a frontend reference: preserve the last snapshot, stop trading on stale quotes, and retain enough error detail to diagnose the failure. In our case, treating every failure as “could not load” hid the clue we needed.
