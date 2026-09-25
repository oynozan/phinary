"""(a1) Rebuild each Thales market's LP ledger from the on-chain tape and reconcile per round against profitAndLossPerRound x allocation."""
import json, pickle, glob, re, numpy as np, datetime as dt, collections
FIRST = 1683629766; RL = 604800; SB = 0.02
def load_markets():
    M = {}
    for f in ('markets_all.json', 'markets_destroyed.json'):
        for m in json.load(open(f)):
            if 'maturity' in m or m['market'] not in M: M[m['market']] = m
    return M
def rounds():
    R = {}
    for l in open('../prior_art/thales_lp_rounds.txt'):
        m = re.match(r'(\d+) (\S+) alloc (\d+) pnl (\S+) cum (\S+)', l)
        if m: R[int(m[1])] = dict(start=m[2], alloc=int(m[3]), pnl=float(m[4]))
    return R
OV = {a: d['safebox'] for a, d in json.load(open('overrides.json')).items() if d['safebox']}
def sbf(t, sb): return OV.get(t['trader'], sb) if sb > 0 else 0.0
def ledgers(tr, M, sb=SB, t_min=FIRST):
    L = collections.defaultdict(lambda: dict(cash=0.0, up=0.0, dn=0.0, vol=0.0, n=0, fee=0.0))
    for t in tr:
        m = M.get(t['market'])
        if not m or 'maturity' not in m or t['ts'] < t_min: continue
        g = L[t['market']]; f = sbf(t, sb)
        if t['side'] == 1:                       # trader buys `amount` of pos for `paid` (incl. safeBox fee, which leaves the LP)
            lp_in = t['paid']/(1+f); g['cash'] += lp_in; g['fee'] += t['paid'] - lp_in
            if t['pos'] == 0: g['up'] += t['amount']
            else: g['dn'] += t['amount']
        else:                                    # trader sells `amount` for `paid`; LP funds paid + safeBox share
            lp_out = t['paid']/(1-f); g['cash'] -= lp_out; g['fee'] += lp_out - t['paid']
            if t['pos'] == 0: g['up'] -= t['amount']
            else: g['dn'] -= t['amount']
        g['vol'] += t['paid']; g['n'] += 1
    out = {}
    for mk, g in L.items():
        m = M[mk]; res = m.get('result')
        if res is None or not m.get('final'): continue
        pay = g['up'] if res == 0 else g['dn']
        rnd = (m['maturity'] - FIRST)//RL + 1 if m['maturity'] > FIRST else 1
        out[mk] = dict(g, pnl=g['cash'] - pay, round=rnd, key=m.get('key'), strike=m['strike'], final=m['final'], maturity=m['maturity'], res=res)
    return out
if __name__ == '__main__':
    tr, iv = pickle.load(open('tape_raw.pkl', 'rb')); M = load_markets(); R = rounds()
    print('markets with details', len(M), 'missing maturity', sum('maturity' not in m for m in M.values()))
    for sb, tmin in ((0.02, FIRST), (0.02, 0), (0.0, FIRST)):
        Lg = ledgers(tr, M, sb, tmin)
        byr = collections.defaultdict(float); byn = collections.Counter()
        for g in Lg.values(): byr[g['round']] += g['pnl']; byn[g['round']] += 1
        act = [r for r in range(1, 92) if R[r]['pnl'] != 1.0]
        on = np.array([R[r]['alloc']*(R[r]['pnl']-1) for r in act]); me = np.array([byr[r] for r in act])
        print(f"safeBox={sb} (per-address overrides) trades from {tmin}: active rounds {len(act)} | on-chain sum {on.sum():+.0f} | tape rebuild sum {me.sum():+.0f} | corr {np.corrcoef(on, me)[0,1]:.3f} | "
              f"sign agreement {np.mean(np.sign(on) == np.sign(me)):.2f} | median |diff| {np.median(np.abs(on-me)):.0f} | rounds with |diff|>max(1000,20%) {np.sum(np.abs(on-me) > np.maximum(1000, 0.2*np.abs(on)))}")
        if sb == 0.02 and tmin == FIRST:
            for r in act:
                print(f"   round {r:3d} {R[r]['start']} alloc {R[r]['alloc']:7d} on-chain {R[r]['alloc']*(R[r]['pnl']-1):+9.0f} rebuild {byr[r]:+9.0f} markets {byn[r]}")
            pickle.dump(Lg, open('ledgers.pkl', 'wb'))
