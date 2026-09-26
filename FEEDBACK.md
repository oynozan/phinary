# Uniswap developer feedback

From the Phinary team, ETHGlobal Tokyo 2026.

## Give each hook a page people can find

Finding a hook should start with a page that explains what it does and where it is deployed. We want to share one link that gives another developer enough information to try it.

The [Uniswap hooklist](https://github.com/Uniswap/hooklist) already contains deployment metadata, and [Hook Discovery](https://developers.uniswap.org/docs/community/learning/hook-discovery) points to community catalogs. A useful next step would be an official browsing experience that brings the description, deployments, permissions, source and a working example together on a page for each hook.

A quote example would be especially helpful for custom pricing hooks. An address and a set of permission flags tell an integrator where to start, but leave them to work out how the hook behaves.

The page should also say whether a hook is simply listed or has been reviewed for routing compatibility. Neither label should imply a security audit. This is the improvement we would put first: make a working hook easier for the next developer to find and try.

## Take the reference example all the way to the wallet

Our swap path includes pool discovery, a V4Quoter call, ERC-20 approval, Permit2, UniversalRouter calldata, simulation and receipt handling. There is quite a bit of integration between a hook contract and a usable buy button.

A small reference app for a custom pricing hook would help. Pin the router address and ABI for a testnet, show a buy and a sell, and include the approval and failure paths. For a new builder, being able to compare one complete transaction against a known working example is more useful than another isolated code snippet.

Please put the routing review step beside that example. Our hook uses `beforeSwapReturnDelta`, and the [routing allowlist form](https://developers.uniswap.org/hook-allowlist) covers hooks using return deltas. Executing through UniversalRouter and appearing in the public Uniswap app are separate milestones. Our interface demo uses a local fork; it does not establish public routing support.

## Keep the hook's error visible

A failed quote can arrive as `UnexpectedRevertBytes -> WrappedError(hook) -> Band`. The last part is the one the trader needs. A price outside the allowed band needs a different response from a closed option, exhausted capacity or a missing approval.

We wrote a [decoder](packages/swap-sdk/src/errors.ts) that unwraps those errors and accepts additional hook error ABIs. A shared decoder, with raw revert examples and their decoded results, would be useful for other custom hooks too. The wrapper should preserve the reason the hook rejected the trade, all the way to the frontend.
