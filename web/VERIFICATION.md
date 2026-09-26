# Frontend v1.0 verification

Scope: frontend, tests and frontend documentation only. Existing contracts, SDK and indexer are not modified. Public-chain writes and extension-wallet validation are outside this release gate.

## Automated checks

- 64 unit tests passed. Tests cover integer input, quote expiry/cutoff, wallet identity, full-registry balance reads, unavailable data, claim rounding/dust, sequential claim interruption, replacement recovery, and Vault transaction states.
- `npm run typecheck`, `npm run lint`, `npm test`, `npm run build -- --webpack`.
- `npm run test:lifecycle:fork`: fixed historical Sepolia fork, test-only oracle and account, both outcome purchases/sales, full registry portfolio, deposit/withdraw, settlement/claim and combined invalid refund. No public-chain submission.
- `npm run test:browser:fork`: Chrome with a test-only EIP-1193 bridge to the local fork. Buys/sells, wallet rejection, reload, Vault and winning claim, responsive routes at 1440/768/390px. Screenshots go to ignored `.review/v1`. Test Next output is isolated in `.next-e2e`; production has no injected signer.

The fork requires Anvil and archival public RPC access. Browser tests require installed Chrome. The separate Activity service is optional for execution; its absence is shown explicitly.

## Independent review

A separate AI reviewed the diff without this conversation or implementation rationale. Two read-only review passes identified:

1. Replacement after reload could leave execution permanently locked. Pending records now capture the submitted transaction nonce and scan mined blocks by sender/nonce, without resending. Different-hash recovery requires balance review rather than reporting the original intent as successful.
2. Portfolio sell confirmation omitted minimum receive. It now shows exact minimum USDC and slippage.
3. Invalid dust entered Claim All despite zero payout. The plan aggregates both sides using bigint and excludes zero-payout markets.
4. Initial recovery fix assigned nonce from the read RPC, risking wallet mempool disagreement. Wallet nonce selection is preserved; nonce is read from the actual submitted transaction for recovery.

Regression tests cover these findings. Legacy records without a saved nonce attempt to recover metadata from the original transaction; an RPC that no longer knows that hash cannot identify its replacement automatically. No automatic resend or blind deletion occurs.

## Read-only public deployment check

2026-09-26, Unichain Sepolia block 63568856: all eight configured contract addresses had code; collateral and six-decimal USDC matched; 743 markets were registered and the latest three were readable. None of those three was tradable at that observation. This verifies reads, not keeper availability or public-wallet execution.

## Release boundaries

Portfolio displays actual holdings; complete transaction history, acquisition cost and P&L remain unavailable. Activity requires a separately supplied compatible `/activity` service (documented in README); the frontend PR does not include that service. The production build retains the existing viem/ox dynamic-import warning.

Latest-main integration: its committed indexer only exposes SQL/GraphQL, while this frontend Activity adapter requires the separately verified `/activity` service. Keep the PR Draft until that service dependency is supplied for the target environment or a separately scoped integration is completed. Local `/api/activity` returned a validated live snapshot during read-only verification.

Browser evidence includes pending approval reload/recovery, wrong-network handling and account isolation. A signature rejection left the form recoverable. Fork tests passed both partial and full sells for each side, winning redemption, invalid combined-side refund, and Vault balance deltas.
