import { test } from "node:test";
import assert from "node:assert/strict";
import {
  selectMarkets,
  underlyingOf,
  hasVolume,
} from "../src/lib/markets/explorer.ts";
import { toMarket } from "../src/lib/onchain/market-adapter.ts";
import { phaseOf } from "../src/lib/phase.ts";
import type { Market } from "../src/lib/types.ts";
const address = "0x1111111111111111111111111111111111111111" as const;
const registry = { [address]: { symbol: "ETH", name: "Ethereum" } };
const base = toMarket(
  1,
  {
    yes: address,
    no: address,
    oracle: address,
    lnStrikeWad: 0n,
    openTime: 1000n,
    expiry: 1060n,
    window: 10,
    cutoffBuffer: 2,
    status: 1,
    yesWon: false,
    bucket: 0n,
    outYes: 0n,
    outNo: 0n,
    invYes: 0n,
    invNo: 0n,
  },
  10,
  undefined,
  1020,
);
const filters = {
  tab: "live",
  underlying: "all",
  search: "",
  sort: "deadline",
} as const;
test("combines state, asset and question search without hiding featured market", () => {
  const list = [base, { ...base, id: 2, phase: "upcoming" } as Market];
  assert.deepEqual(
    selectMarkets(list, filters, registry).map((m) => m.id),
    [1],
  );
  assert.equal(
    selectMarkets(
      list,
      { ...filters, underlying: "ETH", search: "ethereum" },
      registry,
    ).length,
    1,
  );
  assert.equal(
    selectMarkets(list, { ...filters, search: "$1.00" }, registry).length,
    1,
  );
  assert.equal(
    selectMarkets(list, { ...filters, search: "missing" }, registry).length,
    0,
  );
  assert.equal(
    selectMarkets(list, { ...filters, underlying: "WBTC" }, registry).length,
    0,
  );
  assert.equal(list.length, 2);
});
test("unknown oracle is not silently identified as ETH", () => {
  const unknown = {
    ...base,
    id: 3,
    oracle: "0x2222222222222222222222222222222222222222",
  } as Market;
  assert.equal(underlyingOf(unknown, registry).symbol, "Unknown");
  assert.equal(
    selectMarkets([unknown], { ...filters, underlying: "ETH" }, registry)
      .length,
    0,
  );
  assert.equal(selectMarkets([unknown], filters, registry).length, 1);
});
test("volume sorting preserves zero and puts null/NaN last, with deadline tie break", () => {
  const list = [
    { ...base, id: 1, volume: null, cutoff: 1050 },
    { ...base, id: 2, volume: 0 },
    { ...base, id: 3, volume: 30 },
    { ...base, id: 4, volume: NaN, cutoff: 1060 },
  ];
  assert.deepEqual(
    selectMarkets(list, { ...filters, sort: "volume" }, registry).map(
      (m) => m.id,
    ),
    [3, 2, 1, 4],
  );
  assert.equal(hasVolume([base]), false);
  assert.equal(hasVolume([{ ...base, volume: 0 }]), true);
});
test("deadline ordering varies by tab and never mutates input", () => {
  const list = [
    { ...base, id: 2, cutoff: 1100, openTime: 1010, expiry: 1120 },
    base,
  ];
  assert.deepEqual(
    selectMarkets(list, filters, registry).map((m) => m.id),
    [1, 2],
  );
  assert.equal(list[0].id, 2);
  for (const tab of ["upcoming", "resolved"] as const) {
    const mapped = list.map(
      (m) =>
        ({
          ...m,
          phase: tab === "upcoming" ? "upcoming" : "resolved-up",
        }) as Market,
    );
    assert.deepEqual(
      selectMarkets(mapped, { ...filters, tab }, registry).map((m) => m.id),
      tab === "upcoming" ? [1, 2] : [2, 1],
    );
  }
});
test("all unfinalized phases stay in Live, resolved and invalid move to Resolved", () => {
  for (const phase of ["live", "closed", "averaging", "awaiting"] as const)
    assert.equal(
      selectMarkets([{ ...base, phase }], filters, registry).length,
      1,
    );
  for (const phase of ["resolved-up", "resolved-down", "invalid"] as const)
    assert.equal(
      selectMarkets(
        [{ ...base, phase }],
        { ...filters, tab: "resolved" },
        registry,
      ).length,
      1,
    );
  assert.equal(phaseOf(base, base.cutoff), "closed");
});

test("preview price links preserve side selection; unavailable quotes cannot be traded", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { PriceLink } =
    await import("../src/components/home/market-presentation.tsx");
  const quoted = {
    ...base,
    quote: { tradable: true, askUp: 0.41, askDown: 0.63 },
  } as Market;
  for (const side of ["up", "down"] as const) {
    const html = renderToStaticMarkup(
      createElement(PriceLink, { market: quoted, side }),
    );
    assert.match(html, new RegExp(`href="/market/1\\?side=${side}"`));
    for (const phase of [
      "upcoming",
      "closed",
      "averaging",
      "awaiting",
      "resolved-up",
      "resolved-down",
      "invalid",
    ] as const) {
      const inactive = renderToStaticMarkup(
        createElement(PriceLink, { market: { ...quoted, phase }, side }),
      );
      assert.doesNotMatch(inactive, /href=/);
      assert.match(inactive, /aria-disabled="true"/);
    }
  }
  const missing = renderToStaticMarkup(
    createElement(PriceLink, { market: base, side: "up" }),
  );
  assert.match(missing, /N\/A/);
  assert.doesNotMatch(missing, /href=/);
});
test("upcoming and resolved tables show correct columns without fabricated settlement data", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { MarketTable } =
    await import("../src/components/home/market-table.tsx");
  const upcoming = renderToStaticMarkup(
    createElement(MarketTable, {
      markets: [{ ...base, phase: "upcoming" }],
      tab: "upcoming",
      registry,
    }),
  );
  for (const label of ["Spot Price", "Opens In", "Expires At", "Status"])
    assert.ok(upcoming.includes(label));
  assert.doesNotMatch(upcoming, /\?side=/);
  for (const [phase, label] of [
    ["resolved-up", "UP WON"],
    ["resolved-down", "DOWN WON"],
    ["invalid", "INVALID"],
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(MarketTable, {
        markets: [{ ...base, phase }],
        tab: "resolved",
        registry,
      }),
    );
    assert.ok(html.includes(label));
    assert.match(html, /Settlement/);
    assert.match(html, /N\/A/);
    assert.doesNotMatch(html, /\?side=/);
    assert.doesNotMatch(html, /NaN|undefined/);
  }
});
