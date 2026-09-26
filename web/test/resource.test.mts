import { test } from "node:test";
import assert from "node:assert/strict";
import { createResource } from "../src/lib/data/resource.ts";

test("multiple subscribers share one pending request", async () => {
    let calls = 0;
    let finish!: (value: number) => void;
    const resource = createResource(() => { calls++; return new Promise<number>((resolve) => { finish = resolve; }); });
    const a = resource.subscribe(() => {});
    const b = resource.subscribe(() => {});
    const pending = resource.refresh();
    assert.equal(calls, 1);
    finish(42); await pending;
    assert.equal(resource.getSnapshot().data, 42);
    a(); b();
});
test("failure clears stale data, hides RPC details, and retry can recover", async () => {
    let fail = false;
    const resource = createResource(async () => {
        if (fail) throw new Error("https://provider.invalid/secret-key");
        return [];
    });
    await resource.refresh();
    assert.deepEqual(resource.getSnapshot().data, []);
    fail = true; await resource.refresh();
    assert.equal(resource.getSnapshot().data, undefined);
    assert.equal(resource.getSnapshot().isLoading, false);
    assert.ok(resource.getSnapshot().error);
    assert.ok(!resource.getSnapshot().error?.message.includes("secret-key"));
    fail = false; await resource.refresh();
    assert.deepEqual(resource.getSnapshot().data, []);
    assert.equal(resource.getSnapshot().error, undefined);
});
test("polling stops after the last subscriber leaves", async () => {
    let calls = 0;
    const resource = createResource(async () => ++calls, 10);
    const stop = resource.subscribe(() => {});
    await resource.refresh(); stop();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, 1);
});
