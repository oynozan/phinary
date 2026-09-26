import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateActivity, withinHour, type ActivitySnapshot } from '../src/lib/activity/display.ts';
import { sampleActivity, sampleEvent, sampleRecord } from '../preview/activity/fixtures.ts';
const empty: ActivitySnapshot = { events: [], realized: [], tradesComplete: true, accountingComplete: true, asOf: 5000 };
test('one-hour window excludes lower boundary and future timestamps', () => { assert.equal(withinHour(1400, 5000), false); assert.equal(withinHour(1401, 5000), true); assert.equal(withinHour(5000, 5000), true); assert.equal(withinHour(5001, 5000), false); });
test('full-event metrics deduplicate, exclude claims, and do not depend on twelve-row feed', () => { const data = sampleActivity(5000); data.events.push(data.events[1]); const result = aggregateActivity(data); assert.equal(result.feed.length, 12); assert.equal(result.trades, 26); assert.equal(result.volume, data.events.slice(0, 30).filter(r => r.action !== 'Claim').reduce((a, b) => a + b.total!, 0)); assert.ok(result.feed.every((r, i, a) => !i || a[i - 1].timestamp >= r.timestamp)); });
test('empty complete data is zero, incomplete totals and zero-denominator rates are unknown', () => { assert.deepEqual(aggregateActivity(empty), { volume: 0, trades: 0, wins: 0, losses: 0, winRate: null, feed: [], ranking: [] }); const r = aggregateActivity({ ...empty, tradesComplete: false, accountingComplete: false }); assert.equal(r.volume, null); assert.equal(r.trades, null); assert.equal(r.wins, null); assert.equal(r.winRate, null); });
test('wins and losses count resolved positions, exclude invalid and deduplicate', () => { const a = { ...sampleRecord(5000, 1), outcome: 'win' as const }, b = { ...sampleRecord(5000, 2), outcome: 'loss' as const }, c = { ...sampleRecord(5000, 3), outcome: 'invalid' as const }; const r = aggregateActivity({ ...empty, realized: [a, b, c, a] }); assert.equal(r.wins, 1); assert.equal(r.losses, 1); assert.equal(r.winRate, .5); });
test('ranking uses only known realized profit, stable address ties and top ten', () => { const records = Array.from({ length: 14 }, (_, i) => ({ ...sampleRecord(5000, i), account: `0x${i.toString().padStart(40, '0')}`, profit: i === 13 ? null : 5 })); const r = aggregateActivity({ ...empty, realized: records }); assert.equal(r.ranking.length, 10); assert.equal(r.ranking[0].account, records[0].account); assert.ok(r.ranking.every(row => row.profit === 5)); });
test('missing amounts propagate instead of creating plausible totals; stale data uses snapshot time', () => { const event = { ...sampleEvent(5000, 1), total: null }; const snapshot = { ...empty, events: [event], realized: [{ ...sampleRecord(5000, 1), profit: null }] }; const r = aggregateActivity(snapshot); assert.equal(r.volume, null); assert.equal(r.trades, 1); assert.equal(r.ranking.length, 0); assert.equal(aggregateActivity({ ...snapshot, asOf: 8600 }).feed.length, 0); });
test("unknown outcome cannot inflate global or trader win rate", () => { const win = sampleRecord(5000, 1), unknown = { ...win, id: "unknown", outcome: null }; const r = aggregateActivity({ ...empty, realized: [win, unknown] }); assert.equal(r.wins, null); assert.equal(r.losses, null); assert.equal(r.winRate, null); assert.equal(r.ranking[0].winRate, null); });

test('reference fixture produces screenshot totals and meaningful previous-hour deltas', async () => {
 const {referenceActivity}=await import('../preview/activity/fixtures.ts');
 const {activityMomentum}=await import('../src/lib/activity/display.ts');
 const snapshot=referenceActivity(10000), data=aggregateActivity(snapshot), trend=activityMomentum(snapshot);
 assert.equal(data.trades,1197); assert.ok(Math.abs(data.volume!-12500)<.00001);
 assert.equal(data.wins,33); assert.equal(data.losses,25); assert.equal(Math.round(data.winRate!*100),57);
 assert.equal(trend.volumeChange!.toFixed(1),'18.4'); assert.equal(trend.tradeChange!.toFixed(1),'12.1');
 assert.equal(trend.tradeBars!.reduce((a,b)=>a+b,0),1197); assert.equal(data.feed.length,12); assert.equal(data.ranking.length,10);
});
test('momentum excludes claims and does not invent comparison or incomplete chart values', async()=>{
 const {activityMomentum}=await import('../src/lib/activity/display.ts');
 const result=activityMomentum({...empty,events:[{...sampleEvent(5000,1),action:'Claim'}],previousHour:{volume:0,trades:0}});
 assert.equal(result.tradeChange,null);assert.equal(result.volumeChange,null);assert.equal(result.tradeBars!.reduce((a,b)=>a+b,0),0);
 assert.equal(activityMomentum({...empty,tradesComplete:false}).volumeBars,null);
});
