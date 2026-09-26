import test from "node:test";
import assert from "node:assert/strict";
import { checkConnection } from "../src/lib/onchain/check-connection.ts";
import { chainFixture, config, solOracle, tracksConfig } from "./helpers/chain-read.ts";

test("diagnostic checks nine contracts and the scheduler relationships at one block", async () => {
    const f = chainFixture();
    const report = await checkConnection(f.client, config);
    assert.equal(Object.keys(report.contracts).length, 9);
    assert.equal(report.hook.owner, config.marketScheduler);
    assert.equal(report.gatekeeper, null);
    assert.equal(report.tracks.length, 1);
    assert.equal(report.tracks[0].hook, config.predictionHook);
    assert.equal(report.tracks[0].oracle, config.underlyingOracle);
    assert.equal(report.tracks[0].label, "1m");
    assert.equal(report.tracks[0].canOpen, false); // Already-open slot is not a connection error.
    assert.equal(report.blockNumber, "42"); assert.equal(report.marketCount, "35");
    assert.deepEqual(report.markets.map(m => m.id), ["35", "34", "33"]);
    assert.deepEqual(report.warnings, []);
});
test("missing scheduler, code or wrong wiring fails the diagnostic", async () => {
    const f = chainFixture();
    await assert.rejects(checkConnection(f.client, { ...config, marketScheduler: undefined }), /scheduler is missing/);
    f.state.missingCode = config.marketScheduler!;
    await assert.rejects(checkConnection(f.client, config), /No deployed code for marketScheduler/);
    f.state.missingCode = "";
    for (const [field, message] of [["owner", /Hook owner/], ["keeper", /privileged keeper/],
        ["hook", /Scheduler hook/], ["oracle", /Scheduler oracle/], ["marketOracle", /Market .* oracle/]] as const) {
        const fixture = chainFixture(); fixture.state[field] = config.usdc;
        await assert.rejects(checkConnection(fixture.client, config), message);
    }
});
test("gatekeeper layout checks the gatekeeper and every track", async () => {
    const f = chainFixture(tracksConfig);
    const report = await checkConnection(f.client, tracksConfig);
    assert.equal(report.hook.owner, tracksConfig.marketGatekeeper);
    assert.equal(report.gatekeeper, tracksConfig.marketGatekeeper);
    assert.equal(report.contracts.marketGatekeeper, tracksConfig.marketGatekeeper);
    assert.equal(report.contracts.solOracle, solOracle);
    assert.equal(report.contracts.marketScheduler, undefined);
    assert.deepEqual(report.tracks.map(t => `${t.ticker}:${t.label}`), ["ETH1M:1m", "ETH15M:15m", "SOL1M:1m", "SOL15M:15m"]);
    assert.ok(report.tracks.every(t => t.gatekeeper === tracksConfig.marketGatekeeper));
    assert.deepEqual(report.warnings, []);
});
test("gatekeeper layout rejects wrong ownership, wiring and missing schedulers", async () => {
    await assert.rejects(checkConnection(chainFixture(tracksConfig).client, { ...tracksConfig, marketSchedulers: [] }), /scheduler is missing/);
    for (const [field, message] of [["owner", /Hook owner does not match gatekeeper/], ["keeper", /privileged keeper/],
        ["gatekeeperHook", /Gatekeeper hook/], ["hook", /Scheduler hook/], ["gatekeeper", /Scheduler gatekeeper/],
        ["oracle", /Scheduler oracle/], ["marketOracle", /Market .* oracle/]] as const) {
        const fixture = chainFixture(tracksConfig); fixture.state[field] = tracksConfig.usdc;
        await assert.rejects(checkConnection(fixture.client, tracksConfig), message);
    }
    const reordered = chainFixture(tracksConfig);
    reordered.state.schedulers = [...tracksConfig.marketSchedulers].reverse();
    await assert.rejects(checkConnection(reordered.client, tracksConfig), /Gatekeeper schedulers/);
});
test("unavailable trading and fallback variance are warnings, not broken wiring", async () => {
    const f = chainFixture(); f.state.warm = false; f.state.timestamp = 1048n;
    const report = await checkConnection(f.client, config);
    assert.equal(report.oracle?.warm, false);
    assert.equal(report.warnings.length, 2);
    assert.ok(report.markets.every(m => !m.tradable && !m.quoteAvailable));
    f.state.failedOracle = true;
    const unavailable = await checkConnection(f.client, config);
    assert.equal(unavailable.oracle, null);
    assert.ok(unavailable.warnings.some(w => w.includes("unavailable")));
});
