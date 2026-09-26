import type { PortfolioRow } from "../../src/lib/portfolio/view-model";
export function sampleRows(now: number): PortfolioRow[] {
    const base: PortfolioRow = { id: "1:up", marketId: 1, question: "ETH > $2,705.02 at 04:38?", expiry: now + 120, cutoff: now + 108, openTime: now - 60, phase: "live", tradable: true, side: "up", quantity: 24_390_000n, avgCost: .41, currentPrice: .47, value: 11.46, profit: 1.46, profitPercent: 14.6, settledAt: null, disposition: "held" };
    const rows: PortfolioRow[] = [
        base,
        { ...base, id: "2:down", marketId: 2, question: "ETH > $2,720.00 at 04:40?", side: "down", quantity: 132_000_000n, expiry: now + 240, cutoff: now + 228, avgCost: .63, currentPrice: .584, value: 77.09, profit: -6.07, profitPercent: -7.3 },
        { ...base, id: "3:up", marketId: 3, question: "ETH > $2,690.00 at 04:37?", quantity: 80_000_000n, expiry: now + 55, cutoff: now + 43, avgCost: .365, currentPrice: .398, value: 31.84, profit: 2.64, profitPercent: 9.04 },
        { ...base, id: "4:down", marketId: 4, question: "ETH > $2,700.00 at 04:36?", side: "down", quantity: 40_000_000n, expiry: now - 5, cutoff: now - 17, phase: "awaiting", tradable: false, avgCost: .52, currentPrice: null, value: null, profit: null, profitPercent: null },
        { ...base, id: "5:up", marketId: 5, question: "ETH > $2,680.00 at 03:00?", quantity: 160_000_000n, phase: "resolved-up", tradable: false, expiry: now - 3600, cutoff: now - 3612, settledAt: now - 3580, avgCost: .40, currentPrice: 1, value: 160, profit: 96, profitPercent: 150 },
        { ...base, id: "6:down", marketId: 6, question: "ETH > $2,710.00 at 02:00?", side: "down", quantity: 100_000_000n, phase: "invalid", tradable: false, expiry: now - 7200, cutoff: now - 7212, settledAt: now - 7180, avgCost: .46, currentPrice: .5, value: 50, profit: 4, profitPercent: 8.7 },
        { ...base, id: "7:down", marketId: 7, question: "ETH > $2,740.00 at 01:00?", side: "down", phase: "resolved-up", tradable: false, expiry: now - 10800, cutoff: now - 10812, settledAt: now - 10780, quantity: 100_000_000n, avgCost: .22, currentPrice: 0, value: 0, profit: -22, profitPercent: -100 },
        { ...base, id: "8:up", marketId: 8, question: "ETH > $2,650.00 at 00:00?", disposition: "claimed", phase: "resolved-up", tradable: false, quantity: 50_000_000n, expiry: now - 14400, cutoff: now - 14412, settledAt: now - 14380, avgCost: .40, currentPrice: 1, value: 50, profit: 30, profitPercent: 150 },
        { ...base, id: "9:up", marketId: 9, question: "ETH > $2,660.00 at 23:00?", disposition: "refunded", phase: "invalid", tradable: false, quantity: 40_000_000n, expiry: now - 18000, cutoff: now - 18012, settledAt: now - 17980, avgCost: .52, currentPrice: .5, value: 20, profit: -.8, profitPercent: -3.85 },
    ];
    return rows.map((row) => ({ ...row, question: row.question.replace(/at .*\?$/, `at ${new Date(row.expiry * 1000).toISOString().slice(11,16)}?`) }));
}
