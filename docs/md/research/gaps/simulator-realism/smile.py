"""Fit a per-snapshot implied-vol smile sigma(k) = a + b k + c k^2, k = ln(K/F), to Deribit mark prices of OTM options on one expiry,
and price the smile-consistent digital  D(K) = N(d2) - phi(d2) sqrt(tau) sigma'(k)   (= -dC/dK, r = 0, Black on forward F)."""
import numpy as np, json, sys
from scipy.special import ndtr
from scipy.optimize import brentq
def black_norm(k, sd, call):
    # price / F  of a call (K/F = e^k): N(d1) - e^k N(d2); put: e^k N(-d2) - N(-d1)
    d1 = (-k + 0.5*sd*sd)/sd; d2 = d1 - sd
    return ndtr(d1) - np.exp(k)*ndtr(d2) if call else np.exp(k)*ndtr(-d2) - ndtr(-d1)
def implied_sd(p, k, call):
    intr = max(0.0, 1 - np.exp(k)) if call else max(0.0, np.exp(k) - 1)
    if p <= intr + 1e-9: return np.nan
    f = lambda s: black_norm(k, s, call) - p
    try: return brentq(f, 1e-4, 3.0)
    except ValueError: return np.nan
def fit_window(rows, end_ms):
    """rows: (ts, expiry, K, is_call, mark_eth, iv, index). Uses the latest mark per instrument; F = index at that trade.
    Returns dict(t=end_ms, T=expiry, F, a, b, c, kmin, kmax, n) with sigma annualised, or None."""
    if not rows: return None
    T = rows[0][1]
    last = {}
    for r in rows: last[(r[2], r[3])] = r
    F = np.median([r[6] for r in rows[-50:]])
    ks, vs, ws = [], [], []
    for (K, call), r in last.items():
        tau = (T - r[0])/(365*86400e3)
        if tau <= 0: continue
        k = np.log(K/r[6])
        if (call and k < -0.002) or ((not call) and k > 0.002): continue   # OTM (and near-ATM both)
        if r[4] < 0.0002: continue                                        # sub-tick marks carry no smile information
        sd = implied_sd(r[4], k, call)
        if not np.isfinite(sd): continue
        sig = sd/np.sqrt(tau)
        if not (0.05 < sig < 5): continue
        ks.append(np.log(K/F)); vs.append(sig); ws.append(np.exp(-0.5*(k/(sd+1e-9))**2) + 0.05)   # vega-like weight
    if len(ks) < 5: return None
    ks, vs, ws = map(np.array, (ks, vs, ws))
    if (ks < 0).sum() < 2 or (ks > 0).sum() < 2: return None          # need both wings: no linear/flat fallbacks (they mis-state the slope)
    deg = 2
    co = np.polyfit(ks, vs, deg, w=np.sqrt(ws))
    co = np.concatenate([np.zeros(3-len(co)), co])     # [c, b, a]
    c, b, a = co
    resid = float(np.sqrt(np.average((np.polyval(co[-deg-1:], ks) - vs)**2, weights=ws)))
    if resid > 0.10: return None                                       # poor fit (> 10 vol points RMS)
    return dict(t=int(end_ms), T=int(T), F=float(F), a=float(a), b=float(b), c=float(c), kmin=float(ks.min()), kmax=float(ks.max()), n=int(len(ks)), deg=deg, rmse=resid)
def smile_digital(fit, lnK, lnS, tau):
    k = np.clip(lnK - lnS, fit['kmin'], fit['kmax'])
    sig = max(fit['a'] + fit['b']*k + fit['c']*k*k, 0.15)
    dsig = (fit['b'] + 2*fit['c']*k) if fit['kmin'] < lnK - lnS < fit['kmax'] else 0.0
    sd = sig*np.sqrt(tau); d2 = (lnS - lnK - 0.5*sd*sd)/sd
    return float(np.clip(ndtr(d2) - np.exp(-0.5*d2*d2)/np.sqrt(2*np.pi)*np.sqrt(tau)*dsig, 0.0, 1.0)), sig, dsig
if __name__ == '__main__':
    d = json.load(open(sys.argv[1])); out = {}
    for e, rows in sorted(d.items(), key=lambda x: int(x[0])):
        f = fit_window([tuple(r) for r in rows], int(e))
        out[e] = f
    json.dump(out, open(sys.argv[2], 'w'))
    ok = [f for f in out.values() if f]
    print('windows', len(out), 'fitted', len(ok), 'deg2', sum(f['deg'] == 2 for f in ok))
    b = np.array([f['b'] for f in ok if f['deg'] >= 1]); a = np.array([f['a'] for f in ok])
    print('ATM vol median', np.median(a), 'slope b median', np.median(b), 'IQR', np.quantile(b, [.25, .75]))
