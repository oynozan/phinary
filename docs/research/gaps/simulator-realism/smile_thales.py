"""(b) Smile attribution on Thales ETH/BTC trades: Deribit smile-implied digital (same expiry, fitted on the hour before the trade)
vs the Thales odds and the price actually paid."""
import json, pickle, numpy as np, collections, math
import smile as SM
rows = pickle.load(open('rows.pkl', 'rb')); D = json.load(open('deribit/thales.json'))
fits = {}
for k, rr in D.items():
    cur, end = k.split(':'); end = int(end); by = collections.defaultdict(list)
    for r in rr: by[r[1]].append(tuple(r))
    for T, lst in by.items():
        f = SM.fit_window(sorted(lst), end)
        if f: fits[(cur, end, T)] = f
print('fitted windows', len(fits))
out = []
for r in rows:
    if r['key'] not in ('ETH', 'BTC') or 'up_th' not in r: continue
    end = (r['ts']//3600)*3600*1000; f = fits.get((r['key'], end, r['T']*1000))
    if not f: continue
    up_sm, sig, ds = SM.smile_digital(f, math.log(r['K']), math.log(r['S']), r['tau'])
    o = 1.0 if r['res'] == 0 else 0.0
    tok_up = r['pos'] == 0; unit = r['paid']/r['amount']
    v_sm = up_sm if tok_up else 1 - up_sm; v_th = r['up_th'] if tok_up else 1 - r['up_th']
    # trader's edge vs smile per token: buy -> v_sm - unit ; sell -> unit - v_sm
    e_sm = (v_sm - unit) if r['side'] == 1 else (unit - v_sm)
    pay = (o if tok_up else 1 - o)
    lp = r['lp_cash'] - r['amount']*r['side']*pay
    out.append(dict(e_sm=e_sm, amt=r['amount'], lp=lp, q_up=r['q_up'], up_sm=up_sm, up_th=r['up_th'], o=o, sig_sm=sig, sig_th=r['sig'], paid=r['paid'], key=r['key'], tau=r['tau']))
print('ETH/BTC covered trades with a same-expiry Deribit smile', len(out), 'of', sum(1 for r in rows if r['key'] in ('ETH', 'BTC') and 'up_th' in r))
e = np.array([x['e_sm'] for x in out]); lp = np.array([x['lp'] for x in out]); w = np.array([abs(x['q_up']) for x in out])
o = np.array([x['o'] for x in out]); ps = np.array([x['up_sm'] for x in out]); pt = np.array([x['up_th'] for x in out])
print(f"calibration (token-weighted): mean(1{{UP}} - smile) {100*np.average(o-ps, weights=w):+.2f} pp vs mean(1{{UP}} - Thales odds) {100*np.average(o-pt, weights=w):+.2f} pp; "
      f"Brier smile {np.average((o-ps)**2, weights=w):.4f} vs Thales {np.average((o-pt)**2, weights=w):.4f}; mean |smile - Thales| {100*np.average(np.abs(ps-pt), weights=w):.2f} pp; "
      f"median sigma smile/Thales {np.median([x['sig_sm']/x['sig_th'] for x in out]):.2f}")
for lo, hi in ((-1, -0.05), (-0.05, -0.02), (-0.02, 0.0), (0.0, 0.02), (0.02, 0.05), (0.05, 1)):
    m = (e >= lo) & (e < hi)
    print(f"   trader edge vs smile in [{lo:+.2f},{hi:+.2f}): trades {m.sum():6d} volume ${sum(x['paid'] for x, k in zip(out, m) if k):9.0f} LP P&L ${lp[m].sum():+9.0f} ({100*lp[m].sum()/max(sum(x['paid'] for x, k in zip(out, m) if k),1):+.2f}% of vol)")
print(f"   LP P&L on trades a smile-desk would have taken (edge > +1c): ${lp[e > 0.01].sum():+.0f} on {np.sum(e > 0.01)} trades; all covered ${lp.sum():+.0f}")
