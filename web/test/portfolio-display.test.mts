import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleRows } from '../preview/portfolio/fixtures.ts';
import { partitionPortfolio, portfolioTotals, claimPlan, canSell, tokenAmount, amountText, claimSequentially, sectionOf, portfolioUnitPrice } from '../src/lib/portfolio/view-model.ts';
const rows = sampleRows(1000);
test('settled losers enter history; unclaimed invalid remains claimable', () => {
 const groups = partitionPortfolio(rows);
 assert.deepEqual(groups.open.map(r=>r.marketId), [4,3,1,2]);
 assert.deepEqual(groups.claimable.map(r=>r.marketId), [5,6]);
 assert.deepEqual(groups.history.map(r=>r.marketId), [7,8,9]);
 assert.equal(sectionOf({...rows[5], disposition:'refunded'}),'history');
});
test('missing values stay unknown; cash and history are excluded from total', () => {
 const display = {availability:'ready' as const, rows, realized:29.2, walletUsdc:9999};
 assert.equal(portfolioTotals(display).total,null);
 const result=portfolioTotals({...display, rows:rows.filter(r=>r.marketId!==4)});
 assert.equal(result.total,330.39);
 assert.equal(result.claimable,210);
 assert.equal(result.realized,29.2);
 assert.equal(portfolioTotals({...display, availability:'unavailable'}).openCount,null);
 assert.equal(portfolioTotals({...display,rows:[]}).total,0);
});
test('unknown settlement dates and claim values sort last',()=>{
 const groups=partitionPortfolio(rows.map(r=>r.marketId===7?{...r,settledAt:null}:r.marketId===5?{...r,value:null}:r));
 assert.equal(groups.history.at(-1)?.marketId,7);
 assert.equal(groups.claimable.at(-1)?.marketId,5);
});
test('claim count deduplicates market, including both invalid sides',()=>{
 const plan=claimPlan([...rows,{...rows[5],id:'6:up',side:'up'}]);
 assert.equal(plan.positions,3); assert.equal(plan.marketIds.length,2); assert.equal(plan.amount,260);
});
test('sale cutoff is exclusive, and all non-live phases prevent sale',()=>{
 assert.equal(canSell(rows[0],1000),true);
 assert.equal(canSell(rows[0],rows[0].cutoff),false);
 for(const phase of ['upcoming','closed','averaging','awaiting','resolved-up','resolved-down','invalid'] as const) assert.equal(canSell({...rows[0],phase},1000),false);
});
test('token input preserves six-decimal precision and rejects invalid input',()=>{
 for(const value of [0n,1n,10_000_000n,24_390_000n]) assert.equal(tokenAmount(amountText(value)),value);
 for(const value of ['-1','1e3','1.0000001','NaN','']) assert.equal(tokenAmount(value),null);
 assert.equal(tokenAmount(amountText(24_390_000n*25n/100n)),6_097_500n);
});
test('sequential claims preserve successful payouts and continue after failure',async()=>{
 const calls:number[]=[]; const progress:number[]=[];
 const result=await claimSequentially([5,6,5,8],async id=>{calls.push(id);if(id===6)throw Error('sample failure');return id===5?160:50;},p=>progress.push(p.completed));
 assert.deepEqual(calls,[5,6,8]); assert.deepEqual(progress,[0,1,2,3]);
 assert.deepEqual(result,{completed:3,total:3,paid:210,failed:1});
});

test("unit prices preserve precision independently from currency totals",()=>{ assert.equal(portfolioUnitPrice(.365),"$0.365"); assert.equal(portfolioUnitPrice(.584),"$0.584"); assert.equal(portfolioUnitPrice(null),"N/A"); });
