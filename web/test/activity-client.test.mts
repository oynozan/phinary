import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityResource, parseActivity } from '../src/lib/activity/client.ts';
import { sampleActivity } from '../preview/activity/fixtures.ts';
test('response validator rejects malformed accounting and accepts complete snapshots',()=>{
 assert.equal(parseActivity(sampleActivity(5000)).asOf,5000);
 assert.throws(()=>parseActivity({asOf:5000,events:[],realized:[]}));
 const invalid=sampleActivity(5000); invalid.events[0].total=Infinity; assert.throws(()=>parseActivity(invalid));
});
test('history polling retains values and timestamp on failure then recovers without loading flash',async()=>{
 let attempt=0;
 const resource=createActivityResource(async()=>{if(++attempt===2) throw Error('offline');return sampleActivity(5000+attempt);},5,()=>5000);
 const states: ReturnType<typeof resource.getSnapshot>[]=[];
 await new Promise<void>(resolve=>{const stop=resource.subscribe(()=>{states.push(resource.getSnapshot());if(states.length===3){stop();resolve();}});});
 assert.deepEqual(states.map(s=>s.status),['ready','paused','ready']);
 assert.equal(states[1].snapshot,states[0].snapshot);assert.equal(states[1].snapshot?.asOf,5001);
});
test('stale indexed clock is delayed, empty complete results are successful',async()=>{
 const s={...sampleActivity(4000),events:[],realized:[]};
 const resource=createActivityResource(async()=>s,5000,()=>5000);
 await new Promise<void>(resolve=>{const stop=resource.subscribe(()=>{assert.equal(resource.getSnapshot().status,'paused');stop();resolve();});});
});
test('unsubscribe aborts pending request and prevents late results',async()=>{
 let signal:AbortSignal|undefined;
 const resource=createActivityResource(async s=>{signal=s; await new Promise(resolve=>setTimeout(resolve,5));return sampleActivity(5000);});
 const stop=resource.subscribe(()=>assert.fail('should not notify'));stop();
 assert.equal(signal?.aborted,true);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(resource.getSnapshot().snapshot,null);
});
