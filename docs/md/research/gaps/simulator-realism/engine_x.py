"""Extension of econ/engine.run_hook with two new informed agents and three new hook-side defences.
Agents (each run in isolation + noise, as in bt.run): 0 lat, 1 tail, 2 iv, 3 orv, 4 dir  (unchanged, see econ/engine.py)
  5 jump  : tail-ECDF belief (agent 1) with its variance inflated by the walk-forward excess variance of every scheduled event
            (CPI, FOMC, ETF decision/launch, ETH upgrade) that falls in the remaining life of the market.
  6 smile : Deribit-smile digital  N(d2(sigma(k))) - phi(d2) sqrt(tau) sigma'(k)  from the latest 3-hourly fit on the same expiry.
  7 drift : hook's own model at the fresh CEX price shifted by mu*tau, mu = trailing log-drift over P[34] days (walk-forward).
Hook defences (params P[27..30]): ev_on (hook adds the same walk-forward event variance to its own sd^2), halt_pre/halt_post
(no trading in [t_e - pre, t_e + post)), skew (static digital skew add-on: mid += skew * phi(d2)*sqrt(tau), governance-set)."""
import numpy as np, math, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'econ'))
import engine as E
from numba import njit
ncdf, npdf, kernel, bucket_of, _trade = E.ncdf, E.npdf, E.kernel, E.bucket_of, E._trade
BUCKETS_ = E.BUCKETS_
PRE, POST = 5, 90
@njit(cache=True)
def ev_var(t, T, ev_m, ev_J2):
    v = 0.0
    for i in range(len(ev_m)):
        a = ev_m[i] - PRE; b = ev_m[i] + POST
        if b <= t or a > T: continue
        lo = max(a, t); hi = min(b, T)
        v += ev_J2[i]*(hi - lo)/(b - a)
    return v
@njit(cache=True)
def halted(t, ev_m, pre, post):
    for i in range(len(ev_m)):
        if ev_m[i] - pre <= t < ev_m[i] + post: return True
    return False
@njit(cache=True)
def smile_b(t, lnK, lnS, tau, j0, n, sm_t, sm_co):
    """latest snapshot at or before t (must be <= 6 h old). sm_co rows: a, b, c, kmin, kmax."""
    best = -1
    for j in range(j0, j0+n):
        if sm_t[j] <= t and t - sm_t[j] <= 360: best = j
    if best < 0: return -1.0
    a = sm_co[best, 0]; bb = sm_co[best, 1]; c = sm_co[best, 2]; kmin = sm_co[best, 3]; kmax = sm_co[best, 4]
    k = lnK - lnS; kc = min(max(k, kmin), kmax)
    sig = max(a + bb*kc + c*kc*kc, 0.15)
    ds = bb + 2*c*kc if (kmin < k < kmax) else 0.0
    sd = sig*math.sqrt(tau); d2 = (lnS - lnK - 0.5*sd*sd)/sd
    p = ncdf(d2) - npdf(d2)*math.sqrt(tau)*ds
    return min(max(p, 0.001), 0.999)

@njit(cache=True)
def run_hook_x(t0s, tenor, lnK, cex, pool, sigH, sigA, ttab, Q, yidx, SC, P, seed, out, dvol, cum,
               ev_m, ev_J2, sm_j0, sm_n, sm_t, sm_co):
    np.random.seed(seed)
    s, cdl, gam, lam, cut, pmin, kap, lag, fo = P[0], P[1], P[2], P[3], int(P[4]), P[5], P[6], int(P[7]), P[8]
    m_lat, m_tail, m_dir, dstep, dpos, ntr = P[9], P[10], P[11], P[12], P[13], P[14]
    use_seas, kid, nusc = P[15] > 0, int(P[16]), P[17]
    NA = 8
    on = np.zeros(NA, np.bool_)
    on[0] = P[19] > 0; on[1] = P[18] > 0; on[2] = P[23] > 0; on[3] = P[24] > 0; on[4] = P[20] > 0
    on[5] = P[31] > 0; on[6] = P[32] > 0; on[7] = P[33] > 0
    Bud = P[21] if P[21] > 0 else 1.0
    imp_dec = math.exp(-math.log(2.0)/P[22]) if P[22] > 0 else 0.0
    Rb = int(P[26])
    ev_on, hpre, hpost, skew = P[27], P[28], P[29], P[30]
    nsteps = tenor - cut
    eta_inv = P[35]
    parr = ntr/max(nsteps, 1); qn = (eta_inv if eta_inv > 0 else 1.0)/max(ntr, 1e-9)
    for m in range(len(t0s)):
        t0 = t0s[m]; K = lnK[m]; yi = yidx[m]; T = t0 + tenor
        c = np.zeros(NA); y = np.zeros(NA); vol = np.zeros(NA+1)
        cn = 0.0; yn = 0.0; ydir = 0.0; I = 0.0
        for j in range(nsteps):
            t = t0 + j; hmin = tenor - j; tau = hmin/525600.0
            rel = (((t//60) + 48) % 168)*60 + (t % 60)
            sf = (SC[yi, rel+hmin] - SC[yi, rel])/hmin
            var = sigH[t]*sigH[t]*tau
            if use_seas: var *= sf
            evv = ev_var(t, T, ev_m, ev_J2)
            if ev_on > 0: var += ev_on*evv
            sd = math.sqrt(var)
            bi = bucket_of(hmin, BUCKETS_)
            sdA = sigA[t]*math.sqrt(tau*sf)
            if Rb > 0: lnS = pool[t - (t % Rb) - 1 - lag]
            else: lnS = pool[t - lag]
            if kid == 3: mid = kernel(3, lnS - K, sdA, ttab, nusc, Q[yi, bi])
            else: mid = kernel(kid, lnS - K, sd, ttab, nusc, Q[yi, bi])
            d2 = (lnS - K - 0.5*sd*sd)/sd
            mid += skew*npdf(d2)*math.sqrt(tau)
            if imp_dec <= 0.0:
                if Rb <= 0 or (t % Rb) == 0: I = 0.0
            else: I *= imp_dec
            if mid < pmin or mid > 1 - pmin: continue
            if hpre + hpost > 0 and halted(t, ev_m, hpre, hpost): continue
            sp = s + cdl*npdf(d2)/sd*gam
            yinv = y.sum() + (yn if eta_inv > 0 else 0.0)
            mid_e = mid + kap*(-yinv)/Bud
            lam_eff = lam + kap/Bud
            for ag in range(NA):
                if not on[ag]: continue
                cap = 1e9
                if ag == 0:
                    if kid == 3: b = kernel(3, cex[t] - K, sdA, ttab, nusc, Q[yi, bi])
                    else:
                        b = kernel(kid, cex[t] - K, sd, ttab, nusc, Q[yi, bi]) + skew*npdf(d2)*math.sqrt(tau)
                    mg = m_lat
                elif ag == 1:
                    b = kernel(3, cex[t] - K, sdA, ttab, nusc, Q[yi, bi]); mg = m_tail
                elif ag == 2:
                    b = kernel(2, cex[t] - K, dvol[t]*math.sqrt(tau*sf), ttab, nusc, Q[yi, bi]); mg = m_tail
                elif ag == 3:
                    sdo = math.sqrt(max(cum[T] - cum[t], 1e-12))
                    b = ncdf((cex[t] - K - 0.5*sdo*sdo)/sdo); mg = m_tail
                elif ag == 4:
                    mu = 0.5*(cex[t] - cex[t-1440])/1440.0
                    b = ncdf((cex[t] - K + mu*hmin - 0.5*sd*sd)/sd); mg = m_dir
                    cap = dstep
                    if b > mid_e: cap = min(cap, max(dpos - ydir, 0.0))
                    else: cap = min(cap, max(dpos + ydir, 0.0))
                elif ag == 5:
                    b = kernel(3, cex[t] - K, math.sqrt(sdA*sdA + evv), ttab, nusc, Q[yi, bi]); mg = m_tail
                elif ag == 6:
                    b = smile_b(t, K, cex[t], tau, sm_j0[m], sm_n[m], sm_t, sm_co)
                    if b < 0: continue
                    mg = m_tail
                else:
                    # drift agent: the hook's own model at the fresh price, shifted by a walk-forward trailing log-drift (lookback P[34] days)
                    lb = int(P[34]*1440)
                    mu = (cex[t] - cex[max(t - lb, 0)])/(lb/525600.0)
                    mu = min(max(mu, -3.0), 3.0)
                    b = kernel(kid if kid != 3 else 2, cex[t] - K + mu*tau, sd, ttab, nusc, Q[yi, bi]); mg = m_tail
                cb = c.sum() + (cn if eta_inv > 0 else 0.0); yb = y.sum() + (yn if eta_inv > 0 else 0.0)
                q, cash = _trade(b, mg, cap, mid_e, sp, lam*I, lam_eff, fo, cb, yb, Bud)
                if q != 0.0:
                    c[ag] += cash; y[ag] -= q; I += q; vol[ag] += abs(q)
                    mid_e += kap*q/Bud
                    if ag == 4: ydir += q
            if np.random.random() < parr:
                if np.random.random() < 0.5:
                    a = mid_e + sp + 0.5*lam*qn; cn += qn*a; yn -= qn
                    if eta_inv > 0: mid_e -= kap*qn/Bud*(-1.0)
                else:
                    a = mid_e - sp - 0.5*lam*qn; cn -= qn*a; yn += qn
                    if eta_inv > 0: mid_e += kap*qn/Bud*(-1.0)
                vol[NA] += qn
        o = 1.0 if pool[T] > K else 0.0
        for ag in range(NA):
            out[m, ag] = c[ag] + y[ag]*o
            out[m, 9+ag] = vol[ag]
        out[m, 8] = cn + yn*o; out[m, 17] = vol[NA]
