# Phinary
<!-- impeccable:product-schema 1 -->

## Platform
web

## Product Purpose
An onchain ETH binary prediction market on Uniswap v4. The dashboard lets visitors compare actual markets, connect a wallet, and open the existing purchase flow. This surface is an operating interface with a compact product introduction.

## Users
Hackathon demo visitors and users exploring the testnet markets. Broader production audience remains undecided.

## Capabilities and Constraints
Unichain Sepolia. Frontend v1.0 supports actual market reads, wallet connection, UP/DOWN purchases and sales, winning-token redemption, invalid-market refunds, and Vault deposits/withdrawals. Portfolio scans all registered markets and reads actual token balances. Sell and Claim use existing deployed contracts and SDK APIs. Complete transaction history, acquisition cost, realized and unrealized P&L remain unavailable. Existing Activity API integration is read-only and optional for trading; its backend is supplied separately. No contracts, SDK or indexer changes are included.

Transaction input and execution use bigint, reviewed minimum output, wallet identity checks, and persisted pending receipts without automatic resend. Claim All stops on the first failure or unknown confirmation. Preview fixtures stay isolated from live routes. Existing visual design is retained.

## Vault capability
The `/vault` body is an approved extension of the reference-led financial interface. Shared navigation, wallet behavior and other route bodies retain their existing design. The live route reads deployed Unichain Sepolia contracts and supports USDC deposits and share withdrawals. TVL is idle USDC plus every market bucket, including collateral reserved for trader payouts; it is not withdrawable equity. NAV− and NAV+ are the contract's lower and upper equity valuations. Deposit estimates use NAV+, withdrawal estimates use NAV−, and the summary share price is the withdrawal value per displayed share. Shares display 12 decimals; USDC uses six. Withdrawals are limited by both owned shares and available idle USDC.

Execution and validation use bigint arithmetic, refresh contract state before submission, simulate calls, and request exact-amount USDC approval only when allowance is insufficient. The contract has no minimum-output parameter; confirmed amounts may differ from estimates. Pending hashes are persisted and receipt recovery checks existing transactions without resubmitting them. Core balances poll five seconds after each read completes; full market exposure polls after 30 seconds. Failed reads retain the last successful snapshot, identify delayed data, and pause submission when core reads fail.

Historical TVL/share-price charts, APY, 24-hour volume and fee APR remain unavailable on the live screen. Charts and multi-category examples belong only to the explicitly labelled, isolated sample preview. Verification writes run only against a disposable local Anvil fork; no public-chain test transaction is required. See `preview/vault/README.md` for startup, scenarios and verification evidence. Existing contracts, SDK and protocol semantics remain authoritative.

## Brand Commitments
Phinary cyan/violet Phi mark and text wordmark (updated user reference). English UI, UP / DOWN terminology. The user-approved reference is a near-black financial interface with violet atmospheric artwork and compact market tables.

## Evidence on Hand
README.md, DESIGN.md, current data hooks and the approved Markets screenshot and prompt in the conversation. Data and transaction behavior are authoritative over illustrative values in the reference.
