import type { ActivitySnapshot, ActivityEvent, RealizedRecord } from '../../src/lib/activity/display';
export const account = (i: number) => `0x${(0x20330000 + i * 76543).toString(16).padEnd(40, '0').slice(0, 36)}${i.toString(16).padStart(4, '0')}`;
export function sampleEvent(now: number, i: number): ActivityEvent { const side = i % 2 ? 'up' : 'down', amount = 20 + i % 80, price = .25 + (i % 6) * .08; return { id: `trade:${i}`, timestamp: now, account: account(i % 12), action: i % 9 === 0 ? 'Claim' : i % 3 === 0 ? 'Sell' : 'Buy', side, market: `ETH > $${(2700 + (i % 6) * 5).toLocaleString('en-US')}?`, amount, total: amount * (i % 9 === 0 ? (i % 18 === 0 ? .5 : 1) : price) }; }
export function sampleRecord(now: number, i: number): RealizedRecord { const invalid = i % 9 === 0, win = i % 4 !== 0; const payout = invalid ? .5 : win ? 1 : 0; return { id: `position:${i}`, timestamp: now, account: account(i % 12), profit: 50 * payout - 20, outcome: invalid ? 'invalid' : win ? 'win' : 'loss' }; }
export function sampleActivity(now: number): ActivitySnapshot { return { asOf: now, tradesComplete: true, accountingComplete: true, events: Array.from({ length: 30 }, (_, i) => sampleEvent(now - i * 17, i)), realized: Array.from({ length: 24 }, (_, i) => sampleRecord(now - i * 41, i)) }; }

/** Rich, explicitly labelled reference fixture. Never imported by the live route. */
export function referenceActivity(now: number): ActivitySnapshot {
    const addresses = ['6d57:9822','8671:d083','0c07:7e7a','7b6f:bad5','6fec:c04f','09d7:b612','2033:76c6','564c:3a2b','b6c7:c1ed','a1d9:d35d'].map(s => { const [a,b] = s.split(':'); return `0x${a}${'0'.repeat(32)}${b}`; });
    const totals = [554,899,557,460,959,493,748,878,414,306];
    const profits = [220.60,177.53,136.27,99.94,93.71,76.52,62.89,41.34,20.42,18.96];
    const wins = [4,5,3,5,4,3,3,3,2,1], losses = [2,3,3,2,3,3,3,3,2,1];
    const markets = ['ETH > $2,705.02','BTC > $96,500','SOL > $200','GOLD > $2,420','NVIDIA > $120','TSLA > $250','META > $600'];
    const visible = [
        [6,0,452.78,120,'up'],[5,1,4.66,3.90,'down'],[4,2,14.74,2.65,'up'],[9,0,3.97,3.49,'down'],
        [5,3,8.81,7.43,'down'],[1,4,41.51,9.95,'up'],[2,1,27.62,21.17,'down'],[0,0,34.78,9.63,'up'],
        [7,5,12.41,5.20,'down'],[8,2,19.36,8.17,'up'],[3,1,6.22,4.35,'down'],[0,6,11.93,2.63,'up'],
    ] as const;
    const events: ActivityEvent[] = visible.map(([owner,market,amount,total,side],i) => ({id:`reference:${i}`,timestamp:now-i*2,account:addresses[owner],action:'Buy',side,market:markets[market],amount,total}));
    const remaining = [...totals];
    for (const event of events) remaining[addresses.indexOf(event.account)] -= event.total!;
    // Complete each ranked trader's hourly volume, then fill the aggregate with
    // non-ranked traders. Each synthetic event contributes to the charts/totals.
    const weights=[3,5,4,8,7,11,10,13,10,15,19,13,12,10,15,19,23,30], weight=weights.reduce((a,b)=>a+b,0);
    for (let i=0;i<10;i++) for(let bin=0;bin<18;bin++) {
        const cash=remaining[i]*weights[bin]/weight;
        events.push({id:`reference-volume:${i}:${bin}`,timestamp:now-3600+bin*200+120+i,account:addresses[i],action:'Buy',side:'up',market:markets[i%7],amount:cash/.45,total:cash});
    }
    const count=1197-events.length, total=12500-totals.reduce((a,b)=>a+b,0);
    for(let i=0;i<count;i++) {
        const cash=i===count-1 ? total-(count-1)*Math.floor(total/count*1e6)/1e6 : Math.floor(total/count*1e6)/1e6;
        events.push({id:`reference-background:${i}`,timestamp:now-60-Math.floor((1-Math.sqrt(i/count))*3539),account:account(20+i%30),action:'Buy',side:i%2?'up':'down',market:markets[i%7],amount:cash/.5,total:cash});
    }
    const realized: RealizedRecord[]=[];
    for(let i=0;i<10;i++) for(let j=0;j<wins[i]+losses[i];j++) realized.push({id:`reference-outcome:${i}:${j}`,timestamp:now-50-j*40,account:addresses[i],profit:j===0?profits[i]:0,outcome:j<wins[i]?'win':'loss'});
    return {asOf:now,events,realized,tradesComplete:true,accountingComplete:true,previousHour:{volume:12500/1.184,trades:1068}};
}
