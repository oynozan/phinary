"use client";
import { formatUnits } from "viem";
import { useTokenBalance } from "@/lib/onchain/balances";
import { useWalletSession } from "@/lib/onchain/wallet";
import { getConnectionConfig } from "@/lib/onchain/config";
import { formatCents, formatTokens, formatUsd } from "@/lib/format";
import { isResolved, payoutPerToken } from "@/lib/phase";
import type { Market, Side } from "@/lib/types";
import { DetailMetric, blockExplorer } from "./detail-presentation";

export function PositionPanel({ market, upBalance }: { market: Market; upBalance: ReturnType<typeof useTokenBalance> }) {
    const wallet = useWalletSession();
    const downBalance = useTokenBalance(market.down);
    const resolved = isResolved(market.phase);
    const rows = ([{ side: "up", query: upBalance }, { side: "down", query: downBalance }] as const);
    const message = !wallet.address ? "Connect your wallet to see your position." : wallet.chainId !== getConnectionConfig().chainId ? "Switch to Unichain Sepolia to see your position." : null;
    const row = (side: Side, balance: bigint) => {
        const qty = Number(formatUnits(balance, 6));
        const bid = market.quote?.[side === "up" ? "bidUp" : "bidDown"];
        const payout = payoutPerToken(market.phase, side);
        return <div className="detail-position-row" key={side}><dl>
            <DetailMetric label="Side" className={side === "up" ? "detail-up" : "detail-down"}>{side === "up" ? "▲ UP" : "▼ DOWN"}</DetailMetric>
            <DetailMetric label="Amount">{formatTokens(qty)} tokens</DetailMetric>
            {resolved ? <><DetailMetric label="Result">{market.phase === "invalid" ? "50/50" : market.upWon ? "UP wins" : "DOWN wins"}</DetailMetric><DetailMetric label="Redeemable value">{payout === null ? "N/A" : formatUsd(qty * payout)}</DetailMetric></> : <>
                <DetailMetric label="Avg cost">N/A</DetailMetric><DetailMetric label="Current bid">{bid == null ? "N/A" : formatCents(bid, 1)}</DetailMetric>
                <DetailMetric label="Est. position value">{bid == null ? "N/A" : formatUsd(qty * bid)}</DetailMetric><DetailMetric label="Unrealized P&L">N/A</DetailMetric>
            </>}
        </dl><div className="detail-position-actions"><button type="button" disabled title={resolved ? "Claiming is not connected yet" : "Selling is not connected yet"}>{resolved ? "Claim" : "Sell"}</button><a href={`${blockExplorer}/token/${market[side]}`} target="_blank" rel="noreferrer">View token<span className="sr-only"> ({side.toUpperCase()}, opens in a new tab)</span></a></div></div>;
    };
    return <section className="detail-panel detail-position" aria-labelledby="position-heading"><h2 id="position-heading">Your Position</h2>
        {message ? <p className="detail-empty">{message}</p> : <>
            {rows.map(({ side, query }) => query.error ? <div className="detail-empty" key={side}><p>{side.toUpperCase()} balance unavailable.</p><button type="button" onClick={() => void query.refresh()}>Retry balance</button></div> : query.isLoading || query.data == null ? <p key={side} className="detail-empty">Loading {side.toUpperCase()} balance…</p> : query.data > 0n ? row(side, query.data) : null)}
            {rows.every(({ query }) => !query.error && query.data === 0n) ? <p className="detail-empty">No tokens held in this market.</p> : <p className="detail-note">{resolved ? "Claiming is not connected yet." : "Cost basis and P&L are unavailable. Selling is not connected yet."}</p>}
        </>}
    </section>;
}
