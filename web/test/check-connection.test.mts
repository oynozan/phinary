import test from "node:test";
import assert from "node:assert/strict";
import { checkConnection } from "../src/lib/onchain/check-connection.ts";
import { chainFixture, config } from "./helpers/chain-read.ts";

test("diagnostic checks nine contracts and the scheduler relationships at one block", async () => {
    const f = chainFixture();
    const report = await checkConnection(f.client, config);
    assert.equal(Object.keys(report.contracts).length, 9);
    assert.equal(report.scheduler.owner, config.marketScheduler);
    assert.equal(report.scheduler.hook, config.predictionHook);
    assert.equal(report.scheduler.oracle, config.underlyingOracle);
    assert.equal(report.scheduler.canOpen, false); // Already-open slot is not a connection error.
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
