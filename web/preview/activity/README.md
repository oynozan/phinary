# Activity UI preview

This design-first preview always identifies itself as **UI preview · Sample data**. It has no wallet, RPC, indexer or real transaction connection. The production `/activity` route reads Ponder through `/api/activity`, never imports sample data, and remains available without connecting a wallet. See `../../../indexer/README.md` for startup and accounting.

## Start

Run from the worktree's `web/` directory:

```sh
npm run preview:activity
```

Open <http://localhost:3103>. The server binds only to `127.0.0.1` and bundles once at startup; restart it after changing source files. Navigation links to other pages leave the preview for the connected development app at port 3101.

The preview reuses cached local Manrope files from a Next dev/build output when present. It makes no font download requests and otherwise falls back to sans-serif. The orbital artwork is a local app asset.

## Scenarios

Use the persistent toolbar to select Normal, Empty, Unavailable, Initial loading, Initial failure, Update failure, Recovery, Missing accounting or No settlements. Changing scenarios or choosing Reset restores local sample state. Pause updates freezes the current snapshot; Resume updates allows its simulation to continue except in explicitly unavailable/loading/failure scenarios.

Normal generates a sample event and realised-position record every five seconds. Empty stays empty. No settlements keeps trades but has no resolved-position records. Missing accounting retains the feed while accounting-based aggregates and rankings remain unavailable. Initial failure has no previous data. Update failure keeps the last sample snapshot with an Updates delayed label. Recovery starts paused and resumes on the next five-second tick.

All calculations share the snapshot time, with the strict rolling window `asOf - 3600 < timestamp <= asOf`. The feed contains the newest twelve events, including Claim events. Buy and Sell contribute to trade count and volume; Claim does not. Wins and losses count user positions, excluding Invalid refunds. The ranking contains up to ten traders ordered by known realised profit, with unknown accounting excluded rather than inferred from transaction totals.

A paused or failed update retains both snapshot contents and its As of timestamp, making stale data explicit. An unavailable source is not the same as a successful empty result: unavailable values display N/A, while a complete empty trade window can display zero volume and trades. Win rate without qualifying outcomes remains N/A.

## Limits and checks

This preview is only for inspecting layout, status transitions and local aggregation. It does not verify an indexer, wallet network switching or execution. Its status label describes the local simulation, not a real market connection. No screenshot or browser-verification claims are made by this README.

Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` from `web/` for repository checks. Review the implementation report for the checks actually completed in the current session.

## Implementation verification (2026-09-26)

- Browser inspected at 1536, 1280 and 390 CSS pixels; no page-wide horizontal overflow. The real disconnected Activity route showed all five N/A metrics and both unavailable panels, without requiring wallet connection. Shared mobile dock and transparent header remained in place.
- Observed five-second metric/feed updates, pause/resume by keyboard, paused recovery returning to Live, and empty/unavailable/loading/error/missing-accounting/no-settlement scenarios. Hour-expiry boundaries were verified with deterministic tests rather than waiting one hour in the browser.
- Independent source review found an unknown-outcome win-rate issue; fixed and covered by a regression test. Visual inspection was performed inline by the implementing agent; no independent screenshot-based visual verdict is claimed.
- Impeccable source detection returned six advisory type-ramp findings and no primary findings. The scoped Activity type sizes are recorded in DESIGN.md and the design sidecar.
- Actual indexer updates, wallet transactions and network recovery remain unconnected and were not exercised.
- Final checks passed: lint, typecheck, all 39 tests, and `npm run build -- --webpack`. The existing viem/ox dynamic-dependency build warning remains.

## Connected Activity follow-up

The production route is now connected; the earlier implementation report above
records the pre-connection state. The isolated preview remains independent of
RPC/indexer imports. Typography, table alignment and responsive wrapping were
refined, with explicit table labels and column scopes. Production and preview
were checked at 1536, 1280, 768 and 390px without horizontal overflow.

Empty, unavailable, initial loading/failure, update failure, recovery, missing
accounting and no-settlement scenarios were exercised. Five-second updates and
pause were observed. On the real route, injected HTTP 503 responses retained
values and timestamp; restoring the connection returned the status to Live.
The connected route showed the real empty last-hour window after backfill; no
public-chain trade was submitted.

## Reference-fidelity update

Normal now starts with 1,197 sample trade events totalling $12.5K, 33 winning
positions and 25 losing positions (57%). The sample previous-hour baseline
produces +18.4% volume and +12.1% trades. The two eighteen-bar charts aggregate
the same events into 200-second buckets. New simulated events update all values
and the five-second countdown. Reset restores this initial reference fixture.

The screen now includes the reference's metric icons, green/red trade pills with
per-token cents, avatar colors, three medal ranks, win-rate ring, Ethereum mark,
and footer. The last feed column remains Total (USDC) to preserve its meaning.
Multiple asset labels are sample-only; they do not assert deployed markets.
Checked at 1672, 1280, 768 and 390px with no horizontal overflow; live countdown
and value changes were observed. The new direction intentionally supersedes
the earlier minimal-chart styling.
