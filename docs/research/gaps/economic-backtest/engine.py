"""Replayable agent-based backtest of the model-priced hook quote function and reserve-AMM baselines.
One market = (listing minute t0, tenor, ln K). Step = 1 minute. All sizes in units of the per-market LP budget B = 1."""
import numpy as np, math, lib
from numba import njit
from scipy.special import stdtr
from scipy.stats import t as tdist

# ------------------------------------------------------------------ precomputed tables
XG = np.linspace(-60, 60, 48001)
def t_table(nu): return stdtr(nu, XG)
BUCKETS = np.array([2, 5, 10, 20, 40, 60, 120, 240, 480, 720, 1440, 2880, 4320, 7200, 10080])
LEV = np.linspace(0, 1, 401)
YEARS = np.arange(2020, 2028)
def emp_tables(logp, sigA, SC=None, step=10):
    """Walk-forward ECDF quantile tables: Q[y, b, :] = quantiles of x = dlnS(h)/(sigA*sqrt(h/MPY)*sqrt(sf)) using data < Jan 1 of year y,
    where sf is the seasonal variance factor over [t, t+h] from the year-y seasonal profile (SC[y]); sf = 1 if SC is None."""
    Q = np.zeros((len(YEARS), len(BUCKETS), len(LEV)))
    st = lib.minute_of('2020-02-01')
    for yi, Y in enumerate(YEARS):
        end = min(lib.minute_of(f'{max(Y,2021)}-01-01'), lib.N - 1)
        for bi, h in enumerate(BUCKETS):
            ts = np.arange(st, min(end, lib.N - 1) - h, step)
            sf = 1.0
            if SC is not None:
                rel = lib.how_of(ts)*60 + (ts % 60)
                sf = (SC[yi, rel + h] - SC[yi, rel])/h
            sdv = sigA[ts]*np.sqrt(h/lib.MPY)*np.sqrt(sf)
            x = (logp[ts+h] - logp[ts])/sdv
            x = x - x.mean() - 0.5*np.median(sdv)      # drift removed: shape only (martingale-centred), drift is the directional agent's job
            Q[yi, bi] = np.quantile(x, LEV)
    return Q
def year_index(t):
    import datetime
    ms = lib.T0 + np.asarray(t)*60000
    return np.array([datetime.datetime.fromtimestamp(m/1000, datetime.timezone.utc).year for m in ms]) - YEARS[0]
def season_cums(logp):
    """Per-year walk-forward seasonal cumulative tables (3 weeks of minutes)."""
    C = np.zeros((len(YEARS), 3*168*60+1))
    for yi, Y in enumerate(YEARS):
        prof = lib.season_profile(logp, min(lib.minute_of(f'{max(Y,2021)}-01-01'), lib.N))
        C[yi, 1:] = np.cumsum(np.repeat(np.tile(prof, 3), 60))
    return C

# ------------------------------------------------------------------ numba helpers
@njit(cache=True)
def ncdf(x): return 0.5*math.erfc(-x/math.sqrt(2.0))
@njit(cache=True)
def npdf(x): return math.exp(-0.5*x*x)/math.sqrt(2*math.pi)
@njit(cache=True)
def tab(xg, fv, x):
    if x <= xg[0]: return fv[0]
    if x >= xg[-1]: return fv[-1]
    h = (xg[-1]-xg[0])/(len(xg)-1); i = int((x-xg[0])/h); w = (x - xg[i])/h
    return fv[i]*(1-w) + fv[i+1]*w
@njit(cache=True)
def kernel(kid, lnSK, sd, ttab, nu_sc, Qrow):
    """P(YES). kid 0 normal BS N(d2); 1 driftless N(lnSK/sd); 2 Student-t (variance matched); 3 empirical table row."""
    if kid == 0: return ncdf((lnSK - 0.5*sd*sd)/sd)
    if kid == 1: return ncdf(lnSK/sd)
    if kid == 2: return tab(XG_, ttab, (lnSK - 0.5*sd*sd)/(sd*nu_sc))
    # empirical: P(x > -lnSK/sd)
    z = -lnSK/sd
    n = len(Qrow)
    if z <= Qrow[0]: return 1.0
    if z >= Qrow[n-1]: return 0.0
    lo = 0; hi = n-1
    while hi - lo > 1:
        mid = (lo+hi)//2
        if Qrow[mid] <= z: lo = mid
        else: hi = mid
    w = (z - Qrow[lo])/max(Qrow[hi]-Qrow[lo], 1e-12)
    return 1.0 - (lo + w)/(n-1)
XG_ = XG
@njit(cache=True)
def bucket_of(h, B):
    best = 0; bd = 1e18
    lh = math.log(max(h, 1))
    for i in range(len(B)):
        d = abs(math.log(B[i]) - lh)
        if d < bd: bd = d; best = i
    return best

# ------------------------------------------------------------------ hook engine
# params vector P (floats):
# 0 s  1 cdelta 2 gamma 3 lam 4 cut 5 pmin 6 kappa 7 lag 8 fee_out 9 m_lat 10 m_tail 11 m_dir 12 dir_step 13 dir_pos
# 14 noise_trades 15 use_season 16 kid 17 nu_sc 18 tail_on 19 lat_on 20 dir_on 21 settle_lag(unused)
@njit(cache=True)
def _trade(b, margin, cap_q, mid, sp, lamI, lam_eff, fo, c, y, Bud):
    """Agent with belief b trades optimally against linear-impact quotes. Returns (q_signed_yes_bought_by_trader, cash_to_vault)."""
    ask0 = mid + sp + lamI
    bid0 = mid - sp + lamI
    if (b - margin) > ask0*(1+fo):
        q = ((b - margin)/(1+fo) - ask0)/lam_eff
        if q > cap_q: q = cap_q
        # budget (exact): q*(1-ask0) - 0.5*lam*q^2 <= R, R = c + y + B  (LHS increasing on [0, q])
        R = c + y + Bud
        if R <= 0: return 0.0, 0.0
        A1 = 1.0 - ask0; disc = A1*A1 - 2*lam_eff*R
        if disc >= 0:
            qmax = (A1 - math.sqrt(disc))/lam_eff
            if q > qmax: q = qmax
        a = ask0 + 0.5*lam_eff*q
        return q, q*a
    if (b + margin) < bid0*(1-fo):
        q = (bid0 - (b + margin)/(1-fo))/lam_eff
        if q > cap_q: q = cap_q
        # budget (exact): q*bid0 - 0.5*lam*q^2 <= R, R = c + B
        R = c + Bud
        if R <= 0: return 0.0, 0.0
        disc = bid0*bid0 - 2*lam_eff*R
        if disc >= 0 and bid0 > 0:
            qmax = (bid0 - math.sqrt(disc))/lam_eff
            if q > qmax: q = qmax
        a = bid0 - 0.5*lam_eff*q
        return -q, -q*a
    return 0.0, 0.0

@njit(cache=True)
def run_hook(t0s, tenor, lnK, cex, pool, sigH, sigA, ttab, Q, yidx, SC, P, seed, out, dvol, cum):
    """Agents: 0 latency (hook model at fresh CEX price), 1 tail (walk-forward seasonal ECDF standardised by hook's raw sigma input),
    2 implied-vol (Student-t, DVOL, seasonal), 3 oracle-vol (knows realised future variance; stress bound only), 4 directional (momentum).
    Column 5 = noise ledger at unit intensity. Columns 6..11 = volumes."""
    np.random.seed(seed)
    s, cdl, gam, lam, cut, pmin, kap, lag, fo = P[0], P[1], P[2], P[3], int(P[4]), P[5], P[6], int(P[7]), P[8]
    m_lat, m_tail, m_dir, dstep, dpos, ntr = P[9], P[10], P[11], P[12], P[13], P[14]
    use_seas, kid, nusc = P[15] > 0, int(P[16]), P[17]
    on = np.array([P[19] > 0, P[18] > 0, P[23] > 0, P[24] > 0, P[20] > 0])
    Bud = P[21] if P[21] > 0 else 1.0
    imp_dec = math.exp(-math.log(2.0)/P[22]) if P[22] > 0 else 0.0
    Rb = int(P[26])
    nsteps = tenor - cut
    parr = ntr/max(nsteps, 1); qn = 1.0/max(ntr, 1e-9)
    NA = 5
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
            sd = math.sqrt(var)
            bi = bucket_of(hmin, BUCKETS_)
            sdA = sigA[t]*math.sqrt(tau*sf)
            if Rb > 0: lnS = pool[t - (t % Rb) - 1 - lag]     # start-of-block oracle (block = Rb steps)
            else: lnS = pool[t - lag]
            if kid == 3: mid = kernel(3, lnS - K, sdA, ttab, nusc, Q[yi, bi])
            else: mid = kernel(kid, lnS - K, sd, ttab, nusc, Q[yi, bi])
            if imp_dec <= 0.0:
                if Rb <= 0 or (t % Rb) == 0: I = 0.0   # impact resets per step, or per block
            else: I *= imp_dec
            if mid < pmin or mid > 1 - pmin: continue
            d2 = (lnS - K - 0.5*sd*sd)/sd
            sp = s + cdl*npdf(d2)/sd*gam
            mid_e = mid + kap*(-y.sum())/Bud
            lam_eff = lam + kap/Bud
            for ag in range(NA):
                if not on[ag]: continue
                cap = 1e9
                if ag == 0:
                    if kid == 3: b = kernel(3, cex[t] - K, sdA, ttab, nusc, Q[yi, bi])
                    else: b = kernel(kid, cex[t] - K, sd, ttab, nusc, Q[yi, bi])
                    mg = m_lat
                elif ag == 1:
                    b = kernel(3, cex[t] - K, sdA, ttab, nusc, Q[yi, bi]); mg = m_tail
                elif ag == 2:
                    b = kernel(2, cex[t] - K, dvol[t]*math.sqrt(tau*sf), ttab, nusc, Q[yi, bi]); mg = m_tail
                elif ag == 3:
                    sdo = math.sqrt(max(cum[T] - cum[t], 1e-12))
                    b = ncdf((cex[t] - K - 0.5*sdo*sdo)/sdo); mg = m_tail
                else:
                    mu = 0.5*(cex[t] - cex[t-1440])/1440.0
                    b = ncdf((cex[t] - K + mu*hmin - 0.5*sd*sd)/sd); mg = m_dir
                    cap = dstep
                    if b > mid_e: cap = min(cap, max(dpos - ydir, 0.0))
                    else: cap = min(cap, max(dpos + ydir, 0.0))
                q, cash = _trade(b, mg, cap, mid_e, sp, lam*I, lam_eff, fo, c.sum(), y.sum(), Bud)
                if q != 0.0:
                    c[ag] += cash; y[ag] -= q; I += q; vol[ag] += abs(q)
                    mid_e += kap*q/Bud
                    if ag == 4: ydir += q
            if np.random.random() < parr:
                if np.random.random() < 0.5:
                    a = mid_e + sp + 0.5*lam*qn; cn += qn*a; yn -= qn
                else:
                    a = mid_e - sp - 0.5*lam*qn; cn -= qn*a; yn += qn
                vol[NA] += qn
        o = 1.0 if pool[T] > K else 0.0
        for ag in range(NA):
            out[m, ag] = c[ag] + y[ag]*o
            out[m, 6+ag] = vol[ag]
        out[m, 5] = cn + yn*o; out[m, 11] = vol[NA]
BUCKETS_ = BUCKETS.astype(np.float64)

# ------------------------------------------------------------------ reserve-AMM baselines
# amm: 0 = CPMM/FPMM (x YES, y NO, P = y/(x+y)); 1 = LMSR (d, b); 2 = dynamic pm-AMM (u, L_t = L0*sqrt((T-t)/T))
@njit(cache=True)
def ninv(p):
    # Acklam's inverse normal + one Newton step
    if p <= 0: return -40.0
    if p >= 1: return 40.0
    a = (-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00)
    b = (-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01)
    cc = (-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00)
    d = (7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00)
    pl = 0.02425
    if p < pl:
        q = math.sqrt(-2*math.log(p)); x = (((((cc[0]*q+cc[1])*q+cc[2])*q+cc[3])*q+cc[4])*q+cc[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    elif p <= 1-pl:
        q = p-0.5; r = q*q; x = (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)
    else:
        q = math.sqrt(-2*math.log(1-p)); x = -(((((cc[0]*q+cc[1])*q+cc[2])*q+cc[3])*q+cc[4])*q+cc[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    e = ncdf(x) - p; u = e*math.sqrt(2*math.pi)*math.exp(x*x/2); x = x - u/(1+x*u/2)
    return x
@njit(cache=True)
def amm_res(amm, st0, st1, P):
    """reserves (x YES, y NO) at price P for state params (k or L)."""
    if amm == 0:
        k = st0; return math.sqrt(k*(1-P)/P), math.sqrt(k*P/(1-P))
    u = ninv(P); L = st0
    return L*(u*P + npdf(u) - u), L*(u*P + npdf(u))
@njit(cache=True)
def lmsr_C(d, b):
    if d/b > 30: return d + b*math.log1p(math.exp(-d/b))
    return b*math.log1p(math.exp(d/b))
@njit(cache=True)
def amm_move(amm, Pc, Pn, st0, st1):
    """Move pool price Pc -> Pn. Returns (dY to trader [YES tokens], cash paid by trader)."""
    if amm == 1:
        b = st0
        d0 = b*math.log(Pc/(1-Pc)); d1 = b*math.log(Pn/(1-Pn))
        return d1 - d0, lmsr_C(d1, b) - lmsr_C(d0, b)
    x0, y0 = amm_res(amm, st0, st1, Pc); x1, y1 = amm_res(amm, st0, st1, Pn)
    return (y1 - y0) + (x0 - x1), (y1 - y0)
@njit(cache=True)
def amm_to_size(amm, Pc, Ptarget, st0, st1, qcap):
    """Largest move toward Ptarget such that |dY| <= qcap (bisection)."""
    dY, cash = amm_move(amm, Pc, Ptarget, st0, st1)
    if abs(dY) <= qcap: return Ptarget
    lo = Pc; hi = Ptarget
    for _ in range(40):
        mid = 0.5*(lo+hi)
        dY, cash = amm_move(amm, Pc, mid, st0, st1)
        if abs(dY) > qcap: hi = mid
        else: lo = mid
    return lo

@njit(cache=True)
def run_amm(amm, t0s, tenor, lnK, cex, pool, sigH, sigA, ttab, Q, yidx, SC, P, seed, out, dvol, cum):
    np.random.seed(seed)
    fee = P[0]; cut = int(P[4]); pmin = P[5]; nusc = P[17]
    m_lat, m_tail, m_dir, dstep, dpos, ntr = P[9], P[10], P[11], P[12], P[13], P[14]
    on = np.array([P[19] > 0, P[18] > 0, P[23] > 0, P[24] > 0, P[20] > 0, True])
    nsteps = tenor - cut
    parr = ntr/max(nsteps, 1); qn = P[25]/max(ntr, 1e-9)     # P[25] = noise turnover eta per market (AMMs: noise interacts with reserves)
    NA = 6
    for m in range(len(t0s)):
        t0 = t0s[m]; K = lnK[m]; yi = yidx[m]; T = t0 + tenor
        tau0 = tenor/525600.0
        sd0 = sigH[t0]*math.sqrt(tau0)
        P0 = ncdf((pool[t0] - K - 0.5*sd0*sd0)/sd0)
        P0 = min(max(P0, 0.01), 0.99)
        if amm == 0:
            st0 = (1/(2*P0))*(1/(2*(1-P0)))
        elif amm == 1:
            st0 = 1.0/(-math.log(min(P0, 1-P0)))
        else:
            st0 = 1.0/npdf(ninv(P0))
        L0 = st0; Pc = P0
        cash = np.zeros(NA); yv = np.zeros(NA); vol = np.zeros(NA)
        ydir = 0.0
        for j in range(nsteps):
            t = t0 + j; hmin = tenor - j; tau = hmin/525600.0
            if amm == 2:
                st0 = L0*math.sqrt(hmin/tenor)
            rel = (((t//60) + 48) % 168)*60 + (t % 60)
            sf = (SC[yi, rel+hmin] - SC[yi, rel])/hmin
            sd = sigH[t]*math.sqrt(tau)
            sdA = sigA[t]*math.sqrt(tau*sf)
            bi = bucket_of(hmin, BUCKETS_)
            for ag in range(NA):
                if not on[ag]: continue
                cap = 1e9
                if ag == 0:
                    b = ncdf((cex[t] - K - 0.5*sd*sd)/sd); mg = m_lat
                elif ag == 1:
                    b = kernel(3, cex[t] - K, sdA, ttab, nusc, Q[yi, bi]); mg = m_tail
                elif ag == 2:
                    b = kernel(2, cex[t] - K, dvol[t]*math.sqrt(tau*sf), ttab, nusc, Q[yi, bi]); mg = m_tail
                elif ag == 3:
                    sdo = math.sqrt(max(cum[T] - cum[t], 1e-12)); b = ncdf((cex[t] - K - 0.5*sdo*sdo)/sdo); mg = m_tail
                elif ag == 4:
                    mu = 0.5*(cex[t] - cex[t-1440])/1440.0
                    b = ncdf((cex[t] - K + mu*hmin - 0.5*sd*sd)/sd); mg = m_dir; cap = dstep
                    if b > Pc: cap = min(cap, max(dpos - ydir, 0.0))
                    else: cap = min(cap, max(dpos + ydir, 0.0))
                else:
                    if np.random.random() >= parr: continue
                    cap = qn; b = 0.999 if np.random.random() < 0.5 else 0.001; mg = 0.0
                b = min(max(b, pmin), 1-pmin)
                if b - mg > Pc*(1+fee): Pt = (b - mg)/(1+fee)
                elif b + mg < Pc*(1-fee): Pt = (b + mg)/(1-fee)
                else: continue
                Pt = min(max(Pt, pmin), 1-pmin)
                if cap < 1e8: Pt = amm_to_size(amm, Pc, Pt, st0, 0.0, cap)
                dY, cp = amm_move(amm, Pc, Pt, st0, 0.0)
                cash[ag] += cp + fee*abs(cp); yv[ag] -= dY; vol[ag] += abs(dY)
                if ag == 4: ydir += dY
                Pc = Pt
        o = 1.0 if pool[T] > K else 0.0
        for ag in range(NA):
            out[m, ag] = cash[ag] + yv[ag]*o
            out[m, 6+ag] = vol[ag]
