"""(b) Attribution of the realised Thales LP P&L (rebuilt from the tape with actual prices):
 per-trade LP P&L = lp_cash - q_up * 1{UP wins}; decomposed by asset, trader class, jump weeks, model mispricing (driftless vs BS),
 short-horizon markouts (latency), exposure concentration (cap-hitting) and, for ETH/BTC, the Deribit-smile edge."""
import numpy as np, pickle, collections, math, json, datetime as dt, sys
import replay as RP
rows = pickle.load(open('rows.pkl', 'rb'))
rounds = __import__('recon').rounds()
act = [r for r in range(1, 92) if rounds[r]['pnl'] != 1.0]
def pnl(r):
    o = 1.0 if r['res'] == 0 else 0.0
    return r['lp_cash'] - r['amount']*r['side']*(o if r['pos'] == 0 else 1 - o)
def edge(r):   # LP P&L had the trade executed at the Thales mid (zero spread): q_up*(mid - 1{UP})
    if 'up_th' not in r: return np.nan
    return r['q_up']*(r['up_th'] - (1.0 if r['res'] == 0 else 0.0))
P = np.array([pnl(r) for r in rows]); tot = P.sum(); EDG = np.array([edge(r) for r in rows])
print(f"LP-era rebuilt LP P&L ${tot:+.0f} over {len(rows)} trades; volume ${sum(r['paid'] for r in rows):.0f}")
def show(title, keyf, top=None):
    d = collections.defaultdict(lambda: [0.0, 0.0, 0, 0.0]); 
    for r, p, e in zip(rows, P, EDG):
        k = keyf(r); d[k][0] += p; d[k][1] += r['paid']; d[k][2] += 1; d[k][3] += 0 if np.isnan(e) else e
    items = sorted(d.items(), key=lambda x: x[1][0])
    if top: items = items[:top] + [('...', None)] + items[-3:]
    print(f"-- {title}")
    for k, v in items:
        if v is None: print('   ...'); continue
        print(f"   {str(k):<44} P&L ${v[0]:+10.0f} | volume ${v[1]:10.0f} | trades {v[2]:6d} | P&L/vol {100*v[0]/max(v[1],1):+6.2f}% | model edge at Thales mid ${v[3]:+9.0f} ({100*v[3]/max(v[1],1):+.2f}% of vol)")
show('by asset', lambda r: r['key'])
CLS = {'0x2d356b114cbca8deff2d8783eac2a5a5324fe1df': 'RangedMarketsAMM (Thales)', '0xf70a78b2aee201bdddb0255c1938cce53ac85b05': 'TeaVaultV2 (third-party quant vault)'}
show('by trader (top losers for the LP)', lambda r: CLS.get(r['trader'], r['trader']), top=12)
# tenor at trade and moneyness
show('by time to maturity at trade', lambda r: '<2d' if r['tau']*365 < 2 else '2-4d' if r['tau']*365 < 4 else '4-7d' if r['tau']*365 < 7 else '7-14d' if r['tau']*365 < 14 else '>=14d')
show('by traded-token model price (Thales odds)', lambda r: 'n/a' if 'up_th' not in r else ('%.1f' % min(0.9, math.floor(10*(r['up_th'] if r['pos'] == 0 else 1-r['up_th']))/10)))
show('by direction (trader long UP-equivalent?)', lambda r: 'long UP' if r['q_up'] > 0 else 'long DOWN')
# jump weeks: per round, |max daily ETH/BTC return| during the round's maturity week
Z = RP.PX
def wk_move(rnd):
    t0 = RP.FIRST + (rnd-1)*RP.RL; i0 = (t0 - RP.PT0)//60; i1 = i0 + 7*1440
    out = 0
    for k in ('ETH', 'BTC'):
        g = Z[k][max(i0-7*1440, 0):i1]; lr = np.log(g[1440::1440]/g[:-1440:1440]) if len(g) > 2880 else np.array([0])
        out = max(out, np.abs(lr).max())
    return out
rp = collections.defaultdict(float); re_ = collections.defaultdict(float)
for r, p, e in zip(rows, P, EDG): rp[r['rnd']] += p; re_[r['rnd']] += 0 if np.isnan(e) else e
x = np.array([re_[r] for r in act]); y = np.array([rp[r] for r in act])
print(f"-- per-round significance (80 active rounds): rebuilt P&L mean ${y.mean():+.0f}/round, t = {y.mean()/y.std(ddof=1)*np.sqrt(len(y)):+.2f}; model edge at Thales mid mean ${x.mean():+.0f}/round, t = {x.mean()/x.std(ddof=1)*np.sqrt(len(x)):+.2f}")
ret = np.array([rp[r]/rounds[r]['alloc'] for r in act]); print(f"   rebuilt weekly return mean {100*ret.mean():+.3f}%, sd {100*ret.std(ddof=1):.3f}%, t {ret.mean()/ret.std(ddof=1)*np.sqrt(len(ret)):+.2f}")
mv = {r: wk_move(r) for r in act}
thr = np.quantile(list(mv.values()), 0.8)
J = [r for r in act if mv[r] >= thr]
print(f"-- jump rounds (top-20% max |daily return| of ETH/BTC over the 2 weeks ending at round end, thr {100*thr:.1f}%): {len(J)} rounds, P&L ${sum(rp[r] for r in J):+.0f} of ${sum(rp[r] for r in act):+.0f} (model edge ${sum(re_[r] for r in J):+.0f} of ${sum(re_[r] for r in act):+.0f}); on-chain ${sum(rounds[r]['alloc']*(rounds[r]['pnl']-1) for r in J):+.0f} of ${sum(rounds[r]['alloc']*(rounds[r]['pnl']-1) for r in act):+.0f}")
for r in sorted(act, key=lambda r: rp[r])[:6]:
    print(f"   worst rebuilt round {r} ({rounds[r]['start']}): ${rp[r]:+.0f}, on-chain ${rounds[r]['alloc']*(rounds[r]['pnl']-1):+.0f}, max |daily move| {100*mv[r]:.1f}%")
# mispricing vs BS N(d2) with the same sigma (driftless bias): expected LP loss = sum q_up*(up_bs - up_th)  [LP sold UP at a price based on up_th]
dr = [(r['q_up']*(r['up_bs'] - r['up_th'])) for r in rows if 'up_th' in r]
print(f"-- driftless-odds bias: sum q_up*(N(d2) - N(d0)) = ${-sum(dr):+.0f} expected LP P&L from the missing -sigma^2 tau/2 term (negative = LP loses)")
# markouts: model value change in the trader's direction, same sigma, horizon h
def val(r, ts):
    s = RP.spot(r['key'], ts, 0); tau = (r['T'] - ts)/(365*86400)
    if not s or tau <= 0: return None
    return RP.thales_up(s, r['K'], r['sig'], tau)
print("-- markouts (trader gain per UP-equivalent token, model value at t+h minus at t, Thales formula, sigma fixed), volume-weighted:")
for h in (60, 300, 3600, 86400):
    g = []; w = []
    for r in rows:
        if 'up_th' not in r or r['ts'] + h >= r['T']: continue
        v0 = val(r, r['ts']); v1 = val(r, r['ts'] + h)
        if v0 is None or v1 is None: continue
        g.append(np.sign(r['q_up'])*(v1 - v0)); w.append(abs(r['q_up']))
    g = np.array(g); w = np.array(w)
    m = np.average(g, weights=w); se = np.sqrt(np.average((g-m)**2, weights=w)/len(g))
    print(f"   h={h:>6}s: mean {100*m:+.3f} pp/token (SE {100*se:.3f}), token-weighted $ gain to traders {np.sum(g*w):+.0f}, n={len(g)}")
# pre-trade CEX move: did traders trade in the direction of the last 1-5 min CEX move (possible stale Chainlink)?
agree = []; 
for r in rows:
    if 'up_th' not in r: continue
    s0 = RP.spot(r['key'], r['ts'], 0); s5 = RP.spot(r['key'], r['ts'] - 300, 0)
    if s0 and s5 and s0 != s5: agree.append(np.sign(r['q_up']) == np.sign(s0 - s5))
print(f"-- fraction of trades in the direction of the prior 5-min CEX move: {np.mean(agree):.3f} (n={len(agree)}; 0.5 = no latency pattern)")
# exposure concentration: worst-case LP loss per market at maturity vs P&L
mk = collections.defaultdict(lambda: [0.0, 0.0, 0.0])
for r, p in zip(rows, P): mk[r['market']][0] += p; mk[r['market']][1] += r['q_up']; mk[r['market']][2] += r['lp_cash']
wc = {m: min(v[2] - max(v[1], 0), v[2] + min(v[1], 0) * 0 - 0) for m, v in mk.items()}
exp_ = {m: max(abs(v[1]), 1e-9) for m, v in mk.items()}
order = sorted(mk, key=lambda m: -exp_[m]); n10 = max(1, len(order)//10)
top = order[:n10]
print(f"-- concentration: top-10% markets by |net token exposure| ({n10} of {len(order)}) carry P&L ${sum(mk[m][0] for m in top):+.0f} of ${sum(v[0] for v in mk.values()):+.0f}; "
      f"top-1% ${sum(mk[m][0] for m in order[:max(1,len(order)//100)]):+.0f}")
pm = np.array([v[0] for v in mk.values()]); print(f"   per-market P&L: mean {pm.mean():+.1f}, sd {pm.std():.1f}, share of markets losing {np.mean(pm < 0):.2f}, worst 10 markets ${np.sort(pm)[:10].sum():+.0f}")
pickle.dump(P, open('trade_pnl.pkl', 'wb'))
