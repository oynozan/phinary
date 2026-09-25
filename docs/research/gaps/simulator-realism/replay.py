"""(a2) Push the real Thales tape through the simulator's Thales-style accounting (econ/expC THALES config: driftless odds, s = 3%,
persistent inventory skew kappa = 0.15 per budget B, lam = 0.001, buy floor 0.08, 2% fee not paid to the LP), settle with the
on-chain result, aggregate per LP round, and compare with on-chain profitAndLossPerRound."""
import numpy as np, pickle, json, collections, sys, math
from scipy.special import ndtr
import recon
FIRST, RL = recon.FIRST, recon.RL
OVR = json.load(open('overrides.json'))
def sb_of(a): d = OVR.get(a); return d['safebox'] if d and d['safebox'] else 0.02
def sp_of(a): d = OVR.get(a); return d['min_spread'] if d and d['min_spread'] else 0.03
Z = np.load('px1m.npz'); PT0 = int(Z['T0']); PX = {k: Z[k] for k in Z.files if k != 'T0'}
def spot(key, ts, lag_min=1):
    g = PX.get(key)
    if g is None: return None
    i = (ts - PT0)//60 - lag_min
    return float(g[i]) if 0 <= i < len(g) else None
def iv_series(iv):
    S = collections.defaultdict(list)
    for x in iv: S[x['asset']].append((x['ts'], x['iv']/100))
    return S
def iv_at(S, key, ts):
    L = S.get(key)
    if not L: return None
    v = L[0][1]
    for t, s in L:
        if t <= ts: v = s
        else: break
    return v
def thales_up(S, K, sig, tau):   # on-chain odds: N(ln(S/K)/(sig sqrt(tau))), driftless
    return float(ndtr(math.log(S/K)/(sig*math.sqrt(tau))))
def bs_up(S, K, sig, tau):
    sd = sig*math.sqrt(tau); return float(ndtr((math.log(S/K) - 0.5*sd*sd)/sd))
def load():
    tr, iv = pickle.load(open('tape_raw.pkl', 'rb')); M = recon.load_markets()
    return tr, iv, M
def enrich(tr, iv, M):
    """Per LP-era trade: YES-equivalent signed quantity (+ = trader long UP), actual LP cash, model prices."""
    S = iv_series(iv); rows = []
    for t in tr:
        m = M.get(t['market'])
        if not m or 'maturity' not in m or m.get('result') is None or not m.get('final'): continue
        if not (FIRST < m['maturity'] <= FIRST + 91*RL): continue
        key = m['key']; tau = (m['maturity'] - t['ts'])/(365*86400)
        if tau <= 0: continue
        q_up = t['amount'] if t['pos'] == 0 else -t['amount']          # trader's UP-equivalent position change
        if t['side'] == -1: q_up = -q_up
        f = sb_of(t['trader']); lp_cash = t['paid']/(1+f) if t['side'] == 1 else -t['paid']/(1-f)
        s0 = spot(key, t['ts']); sig = iv_at(S, key, t['ts'])
        r = dict(t, key=key, K=m['strike'], T=m['maturity'], res=m['result'], final=m['final'], tau=tau, q_up=q_up, lp_cash=lp_cash,
                 S=s0, sig=sig, rnd=(m['maturity'] - FIRST)//RL + 1)
        if s0 and sig:
            r['up_th'] = thales_up(s0, m['strike'], sig, tau); r['up_bs'] = bs_up(s0, m['strike'], sig, tau)
        rows.append(r)
    return rows
def sim_replay(rows, B=5000.0, s=None, kappa=0.15, lam=0.001, floor=0.08, use_sigma='onchain', DV=None):
    """Simulator accounting on the real tape. Returns per-trade LP cash (YES-equivalent ledger) and per-market settlement."""
    inv = collections.defaultdict(float)     # vault UP-equivalent inventory per market (y in engine: negative when traders are long UP)
    cash = []
    for r in rows:
        if 'up_th' not in r:                                                # no price data: actual on-chain cash, converted to YES-equivalent
            cash.append(r['lp_cash'] if r['pos'] == 0 else r['lp_cash'] - r['amount']*r['side']); inv[r['market']] -= r['q_up']; continue
        up = r['up_th']; sp = sp_of(r['trader']) if s is None else s
        y = inv[r["market"]]; mid_e = up + kappa*(-y)/B; lam_eff = (lam + kappa)/B   # engine sizes are in units of B
        # trader's side: buying UP or DOWN (a DOWN buy is an UP sell at the bid); sells to the AMM likewise
        q = r['q_up']
        buying_token = r['side'] == 1
        if q > 0:     # trader long UP-equivalent: UP buy, or DOWN sell
            if buying_token:  a = max(mid_e, floor) + sp + 0.5*lam_eff*q          # UP buy at ask
            else:             a = min(mid_e, 1 - floor) + sp + 0.5*lam_eff*q      # DOWN sold back = UP bought at (1 - DOWN bid)
            c = q*min(a, 0.99)
        else:
            qa = -q
            if buying_token:  a = min(mid_e, 1 - floor) - sp - 0.5*lam_eff*qa     # DOWN buy = UP sell at bid
            else:             a = max(mid_e, floor) - sp - 0.5*lam_eff*qa         # UP sold back at bid
            c = -qa*max(a, 0.01)
        inv[r['market']] = y - q
        cash.append(c)
    return np.array(cash)
def settle(rows, cash, yes_equiv=True):
    """yes_equiv=True: cash is in the engine's YES-equivalent convention (a DOWN buy is an UP sell at 1 - p_down), settle q_up*1{UP}.
    yes_equiv=False: cash is actual token cash (DOWN buy pays p_down), settle UP and DOWN token positions separately."""
    out = collections.defaultdict(float); mk = collections.defaultdict(float); up = collections.defaultdict(float); dn = collections.defaultdict(float); meta = {}
    for r, c in zip(rows, cash):
        mk[r['market']] += c; meta[r['market']] = r
        if yes_equiv: up[r['market']] += r['q_up']
        else:
            q = r['amount']*r['side']
            if r['pos'] == 0: up[r['market']] += q
            else: dn[r['market']] += q
    for m in mk:
        r = meta[m]; o = 1.0 if r['res'] == 0 else 0.0
        out[m] = mk[m] - up[m]*o - dn[m]*(1 - o)
    return out, meta
def per_round(pm, meta):
    R = collections.defaultdict(float)
    for m, p in pm.items(): R[meta[m]['rnd']] += p
    return R
def cum_return(Rd, rounds):
    act = [r for r in range(1, 92) if rounds[r]['pnl'] != 1.0]
    c = 1.0
    for r in act: c *= 1 + Rd.get(r, 0.0)/rounds[r]['alloc']
    return c
if __name__ == '__main__':
    tr, iv, M = load(); rows = enrich(tr, iv, M); rounds = recon.rounds()
    pickle.dump(rows, open('rows.pkl', 'wb'))
    cov = np.mean(['up_th' in r for r in rows]); vcov = sum(r['paid'] for r in rows if 'up_th' in r)/sum(r['paid'] for r in rows)
    print(f"LP-era trades {len(rows)}, markets {len({r['market'] for r in rows})}, price-data coverage {cov:.3f} (by volume {vcov:.3f})")
    act = [r for r in range(1, 92) if rounds[r]['pnl'] != 1.0]
    onchain = {r: rounds[r]['alloc']*(rounds[r]['pnl']-1) for r in act}
    print(f"on-chain: sum ${sum(onchain.values()):+.0f}, cumulative return {cum_return(onchain, rounds):.4f}")
    pa, meta = settle(rows, np.array([r['lp_cash'] for r in rows]), yes_equiv=False); Ra = per_round(pa, meta)
    print(f"tape rebuild (actual prices): sum ${sum(Ra.get(r,0) for r in act):+.0f}, cumulative {cum_return(Ra, rounds):.4f}, corr with on-chain per round {np.corrcoef([onchain[r] for r in act], [Ra.get(r,0) for r in act])[0,1]:.3f}")
    # price fidelity: actual unit price (LP-received basis) vs Thales base + 3%
    d = []
    for r in rows:
        if 'up_th' not in r: continue
        base = r['up_th'] if (r['q_up'] > 0) == (r['side'] == 1) else 1 - r['up_th']   # price of the token actually traded... (UP if buying UP)
        tok_up = (r['pos'] == 0)
        p_tok = r['up_th'] if tok_up else 1 - r['up_th']
        unit = r['paid']/r['amount']
        f = sb_of(r['trader']); sp = sp_of(r['trader'])
        if r['side'] == 1: d.append((unit/(1+f) - (max(p_tok, 0.08) + sp), r['paid']))
        else: d.append((unit/(1-f) - (min(p_tok, 0.95) - sp), r['paid']))
    d = np.array(d)
    print(f"price fidelity: actual - (base +/- 3%) : median {np.median(d[:,0]):+.4f}, IQR [{np.quantile(d[:,0],.25):+.4f},{np.quantile(d[:,0],.75):+.4f}], vol-weighted mean {np.average(d[:,0], weights=d[:,1]):+.4f}")
    for B, kap, sfix in ((2000.0, 0.15, None), (5000.0, 0.15, None), (20000.0, 0.15, None), (5000.0, 0.0, None), (5000.0, 0.15, 0.03)):
            c = sim_replay(rows, B=B, kappa=kap, s=sfix); ps, meta = settle(rows, c); Rs = per_round(ps, meta)
            sim = [Rs.get(r, 0) for r in act]
            print(f"SIM replay B={B:>7.0f} kappa={kap} spread={'per-address' if sfix is None else sfix}: sum ${sum(sim):+.0f}, cumulative {cum_return(Rs, rounds):.4f}, per-round corr with on-chain {np.corrcoef([onchain[r] for r in act], sim)[0,1]:.3f}, sign agreement {np.mean(np.sign([onchain[r] for r in act]) == np.sign(sim)):.2f}")

def decompose(rows):
    """LP P&L decomposition on the covered (price-data) trades, YES-equivalent convention:
       actual = model-edge at Thales odds (trades executed at the Thales mid, no spread) + execution margin (actual price - mid)."""
    cov = [r for r in rows if 'up_th' in r]
    ye = lambda r: r['lp_cash'] if r['pos'] == 0 else r['lp_cash'] - r['amount']*r['side']
    act = np.array([ye(r) for r in cov])
    mid_th = np.array([r['q_up']*r['up_th'] for r in cov]); mid_bs = np.array([r['q_up']*r['up_bs'] for r in cov])
    pa, meta = settle(cov, act); p_th, _ = settle(cov, mid_th); p_bs, _ = settle(cov, mid_bs)
    return sum(pa.values()), sum(p_th.values()), sum(p_bs.values()), act - mid_th, cov
if __name__ == '__main__':
    A_, TH_, BS_, marg, cov = decompose(rows)
    print(f"DECOMPOSITION (covered trades, {len(cov)}): actual LP P&L ${A_:+.0f} = at-Thales-mid (zero spread) ${TH_:+.0f} + execution margin ${A_-TH_:+.0f}; at BS N(d2) mid (zero spread) ${BS_:+.0f}")
    ov = np.array([r['trader'] in OVR and bool(OVR[r['trader']]['min_spread']) for r in cov])
    print(f"   execution margin from whitelisted 0.5%-spread contracts ${marg[ov].sum():+.0f} on volume ${sum(r['paid'] for r, o in zip(cov, ov) if o):.0f}; from others ${marg[~ov].sum():+.0f} on ${sum(r['paid'] for r, o in zip(cov, ov) if not o):.0f}")
    tok = np.array([abs(r['q_up']) for r in cov]); print(f"   effective margin per token: whitelisted {100*marg[ov].sum()/tok[ov].sum():.2f}c, others {100*marg[~ov].sum()/tok[~ov].sum():.2f}c (nominal 0.5c / 3c)")
