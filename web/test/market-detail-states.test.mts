/** Isolated UI fixtures: no wallet provider, RPC or transaction is used. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";

const fixture = `
export let state = {};
export function setState(value) { state = value; }
export function useWalletSession() { return { options: [], status: "connected", address: "0x1111111111111111111111111111111111111111", chainId: 1301, usdc: 42000000n, eth: 100000n, ...state.wallet }; }
export function useTransaction() { return { busy: false, ...state.transaction }; }
export function useBuyQuote(_id, _amount, _slippage, _account, enabled) { return enabled ? state.quoteQuery ?? {} : {}; }
export function useTokenBalance() { return { data: 0n, isLoading: false, refresh() {}, ...state.balance }; }
export function useNow() { return state.now ?? 1020; }
export function retryMarkets() {}
export async function refreshWalletBalances() {}
export async function switchWalletNetwork() {}
export async function connectWallet() { throw Error("Fixture cannot connect"); }
export async function buyUp() { throw Error("Fixture cannot transact"); }
export async function checkPendingTransaction() {}
`;

test("isolated trade and position UI covers wallet, quote, phase and balance states", async () => {
    const cache = join(process.cwd(), "node_modules/.cache");
    await mkdir(cache, { recursive: true });
    const dir = await mkdtemp(join(cache, "detail-ui-"));
    const outfile = join(dir, "fixture.cjs");
    try {
        await build({
            absWorkingDir: process.cwd(), outfile, bundle: true, platform: "node", format: "cjs", packages: "external", logLevel: "silent",
            stdin: { resolveDir: process.cwd(), sourcefile: "detail-fixture.tsx", loader: "tsx", contents: `
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TradeCard } from "./src/components/trade/trade-card";
import { PositionPanel } from "./src/app/market/[id]/_components/position-panel";
import { setState } from "detail-test-state";
export function render(market, state = {}, side = "up", amount = "10") {
 setState(state);
 const holdings = { data: 0n, isLoading: false, refresh() {}, ...state.upBalance };
 return { trade: renderToStaticMarkup(<TradeCard market={market} form={{mode:"buy",side,amount,max:false}} onFormChange={() => {}} holdings={holdings}/>), position: renderToStaticMarkup(<PositionPanel market={market} upBalance={holdings}/>) };
}` },
            plugins: [{ name: "isolated-view-hooks", setup(b) {
                b.onResolve({ filter: /^(detail-test-state|@\/lib\/data|@\/lib\/onchain\/(wallet|transactions|use-buy-quote|balances))$/ }, () => ({ path: "fixture-hooks", namespace: "fixture" }));
                b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: fixture, loader: "js" }));
            } }],
        });
        const { render } = createRequire(import.meta.url)(outfile);
        const address = "0x1111111111111111111111111111111111111111";
        const quote = { tradable: true, midUp: .39, askUp: .41, bidUp: .37, askDown: .63, bidDown: .59, spot: 2704.37, sigma: .582 };
        const market = { id: 42, up: address, down: address, phase: "live", cutoff: 1108, quote };
        const quoteQuery = { quote: { amountIn: 10000000n, amountOut: 24390000n, minimumOut: 24000000n, blockTime: 1020 } };
        const enabled = (html: string) => /<button[^>]*class="detail-primary"(?![^>]*disabled)[^>]*>Buy UP<\/button>/.test(html);
        const ready = render(market, { quoteQuery });
        assert.equal(enabled(ready.trade), true); assert.match(ready.trade, /24.39 UP/); assert.match(ready.trade, /\+\$14.39/);
        assert.match(ready.position, /No tokens held/);
        const disconnected = render(market, { wallet: { status: "disconnected", address: null, chainId: null } });
        assert.match(disconnected.trade, />Connect wallet<\/button>/); assert.match(disconnected.position, /Connect your wallet/);
        const wrong = render(market, { wallet: { chainId: 1 } });
        assert.match(wrong.trade, />Switch to Unichain Sepolia<\/button>/); assert.match(wrong.position, /Switch to Unichain/);
        for (const [state, expected] of [
            [{ wallet: { usdc: 0n }, quoteQuery }, "Not enough USDC"],
            [{ wallet: { eth: 0n }, quoteQuery }, "Test ETH required for gas"],
            [{ wallet: { usdc: null }, quoteQuery }, "USDC balance unavailable"],
            [{ quoteQuery: { error: "Quote unavailable. Retrying automatically." } }, "Quote unavailable"],
            [{ now: 1040, quoteQuery }, "Refreshing quote"],
            [{ transaction: { busy: true, progress: { step: "sign", message: "Awaiting signature" } }, quoteQuery }, "Awaiting signature"],
            [{ transaction: { pending: { hash: "0x123" } } }, "Check confirmation"],
        ] as const) {
            const html = render(market, state).trade;
            assert.equal(enabled(html), false, expected); assert.ok(html.includes(expected), expected);
        }
        const down = render(market, { quoteQuery }, "down").trade;
        assert.equal(enabled(down), false); assert.match(down, /DOWN is preview only/); assert.doesNotMatch(down, /24.39 UP/);
        for (const phase of ["upcoming", "closed", "averaging", "awaiting", "resolved-up", "resolved-down", "invalid"]) {
            const html = render({ ...market, phase, quote: null }, { quoteQuery }).trade;
            assert.equal(enabled(html), false, phase);
            if (phase.startsWith("resolved") || phase === "invalid") assert.match(html, /Claim unavailable/);
        }
        const position = render(market, { upBalance: { data: 24390000n } }).position;
        assert.match(position, /24.39 tokens/); assert.match(position, /37.0¢/); assert.match(position, /\$9.02/);
        assert.match(position, /Avg cost<\/dt><dd>N\/A/); assert.match(position, /Unrealized P&amp;L<\/dt><dd>N\/A/);
        const error = render(market, { upBalance: { data: undefined, error: new Error("RPC failed") } }).position;
        assert.match(error, /UP balance unavailable/); assert.doesNotMatch(error, /No tokens held/);
        const invalid = render({ ...market, phase: "invalid", quote: null }, { upBalance: { data: 2000000n } }).position;
        assert.match(invalid, /\$1.00/); assert.match(invalid, /Claiming is not connected/);
    } finally { await rm(dir, { recursive: true, force: true }); }
});
