# Intermittent market refresh failures — 2026-09-26 UTC

## Captured failure

The canonical public endpoint (`https://sepolia.unichain.org`) intermittently
returned HTTP 200 with a JSON-RPC `result: null` for `eth_call`. The viem contract
reader reported this as `ContractFunctionZeroDataError` / `AbiDecodingZeroDataError`
("marketCount returned no data (0x)"). The same issue occurred at `market-info`.
Recorded failed snapshot durations included 500, 540, 643, 713, 805, 936 and 1117 ms:
these failures were not the configured 15-second timeout.

The initial HTTP-only observer missed the problem: a successful HTTP status and
absence of a JSON-RPC `error` object do not guarantee a valid contract result.

## Same-block replay

A raw RPC probe observed `result: null` at blocks `0x3ca4859` and `0x3ca4883` for
`marketCount()` on `0xE6780bBeAee4183Ffd8EBe0d2862dEd221B96aA8`.
Replaying that exact call/block on both the original endpoint and
`https://unichain-sepolia-rpc.publicnode.com` returned:

```
0x000000000000000000000000000000000000000000000000000000000000013c
```

That is 316 markets. Both endpoints reported chain ID 1301. The observations
establish intermittent invalid read results from the primary endpoint, rather
than a missing deployment or a valid zero-market response. They do not establish
which internal provider node, cache or state propagation mechanism caused it.

## Fix

The read transport rejects null `eth_call` results and empty `0x` results for a
small allowlist of value-returning reads. viem's fallback then retries the exact
request, preserving the block number, on the independent endpoint. HTTP and RPC
errors retain viem's normal fallback semantics. Valid ABI-encoded zero values,
void simulations, and null pending transaction receipts remain valid.

Public fallback applies only to the canonical Sepolia URL and chain ID. A custom
RPC or local fork never falls through to a public chain. Signing remains in the
connected wallet. If both endpoints fail, cached content stays visible, quotes
and trading stay unavailable, and a small reserved header indicator shows recovery
status without inserting a banner or shifting the page.

Development builds record sanitized failure metadata in a bounded in-memory
buffer at `/api/dev/market-errors`; this endpoint returns 404 in production. The
browser also logs `[market-read]` with stage and exception classification.

## Verification

- Unit tests reproduce HTTP-success/null and empty-hex responses; verify exact
  pinned-block preservation, failure when both endpoints fail, and fork isolation.
- Browser reproduction injected null for every primary contract read: 9 empty
  reads recovered through 9 successful backup responses; both list and detail
  rendered without a stale-data indicator.
- Browser outage test blocks both RPCs: the same market component remains mounted,
  trading is disabled, and recovery does not reset the page.
- A two-minute live observation made 160 primary RPC requests and captured three
  real (uninjected) null results. All three recovered through the backup, with
  zero backup failures, visible stale-state samples, or browser errors. Recorded
  locally in `.review/rpc-recovery-verification.json`; not a guarantee of future uptime.
- Typecheck, lint, all 92 unit tests, and the production build passed.

## Separate history / Portfolio report

`/api/markets/306/history` consistently failed with `Invalid price`, even though
Ponder was synced and had the market. Its price rows include a valid ask of 1.02:
`BinaryPricer.askBid` adds the base spread after calculating the probability band.
Both the server and browser history validators incorrectly capped asks at 1.
The fix preserves nonnegative finite asks above 1, while keeping probability and
bid bounds. The actual API now returns 50 price points for market 306.

Portfolio reads holdings separately from market history. The connected account
`0x2356…6a85` had zero outcome-token holdings and zero configured USDC at block
63589493, independently checked through PublicNode. The local indexer also had no
positions or trades for it. Complete Portfolio accounting/history is not wired;
the UI now distinguishes this limitation from zero results and read errors.
