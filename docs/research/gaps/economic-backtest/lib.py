"""Shared data + model layer for the economic backtest (1-minute ETH data)."""
import numpy as np, json, os
from scipy.special import ndtr, stdtr
D = os.path.join(os.path.dirname(__file__), 'data')
MPY = 365*24*60            # minutes per year
_z = np.load(os.path.join(D, 'eth1m.npz'))
T0 = int(_z['t0']); PX = _z['px'].astype(np.float64)   # Binance ETHUSDT 1m closes, t0=2020-01-01 00:00 UTC
N = len(PX)
LOGS = np.log(PX)
def minute_of(datestr):
    import datetime
    t = datetime.datetime.strptime(datestr, '%Y-%m-%d').replace(tzinfo=datetime.timezone.utc).timestamp()*1000
    return int((t - T0)//60000)

def band_path(logs, f):
    """Pool log-price that only moves when the CEX price leaves the +/-f fee band (no-noise arbitrage model, 05 sec 5.3)."""
    out = np.empty_like(logs); p = logs[0]
    lo = logs - f; hi = logs + f
    for i in range(len(logs)):       # numba-free; ~3.5M iterations, ~2 s
        if p < lo[i]: p = lo[i]
        elif p > hi[i]: p = hi[i]
        out[i] = p
    return out

_cache = os.path.join(D, 'pool5bp.npy')
if os.path.exists(_cache): POOL = np.load(_cache)
else:
    POOL = band_path(LOGS, 5e-4); np.save(_cache, POOL)

def ewma_sigma(logp, half_life_min, step=5, warm=30*1440):
    """EWMA of squared `step`-minute log returns, updated every `step` minutes, forward-filled; annualised.
    Value at minute i uses returns ending at or before i (no look-ahead)."""
    idx = np.arange(0, len(logp), step)
    r = np.diff(logp[idx]); r2 = r*r
    lam = 0.5**(step/half_life_min)
    from scipy.signal import lfilter
    v0 = np.mean(r2[:warm//step])
    s, _ = lfilter([1-lam], [1, -lam], r2, zi=[lam*v0])
    var_per_min = s/step
    out = np.empty(len(logp)); out[:step] = np.sqrt(v0/step*MPY)
    # sample k (index idx[k+1]) known from minute idx[k+1] on
    vals = np.sqrt(var_per_min*MPY)
    rep = np.repeat(vals, step)[:len(logp)-step]
    out[step:step+len(rep)] = rep
    out[step+len(rep):] = vals[-1]
    return out

def dvol_minutely():
    d = json.load(open(os.path.join(D, 'dvol_1h.json')))
    ts = np.array([r[0] for r in d]); v = np.array([r[1] for r in d])/100
    # DVOL candle at ts (hour start) closes at ts+1h -> usable from minute (ts+1h-T0)/60000
    m = ((ts + 3600_000 - T0)//60000).astype(np.int64)
    out = np.full(N, np.nan)
    ok = (m >= 0) & (m < N); m = m[ok]; v = v[ok]
    out[m] = v
    # forward fill
    last = np.nan
    for i in range(N):
        if np.isnan(out[i]): out[i] = last
        else: last = out[i]
    return out

WEEKDAY0 = 2   # 2020-01-01 is a Wednesday (Mon=0)
def how_of(m):
    """hour-of-week (Mon 00:00 UTC = 0) of minute index m"""
    return ((np.asarray(m)//60) + 24*WEEKDAY0) % 168

def season_profile(logp, upto_min, lookback_min=365*1440):
    """Robust hour-of-week variance profile (mean 1): 24 hour-of-day buckets x {weekday, weekend},
    from winsorised 1m returns in [upto-lookback, upto). Uses only data before upto_min (walk-forward)."""
    a = max(1, upto_min - lookback_min)
    r = np.diff(logp[a-1:upto_min])
    c = 5*np.sqrt(np.mean(r*r)); r = np.clip(r, -c, c)
    how = how_of(np.arange(a, upto_min))
    hod = how % 24; wkend = (how//24) >= 5
    b = hod + 24*wkend
    v = np.bincount(b, weights=r*r, minlength=48)/np.maximum(np.bincount(b, minlength=48), 1)
    h = np.arange(168); prof = v[(h % 24) + 24*((h//24) >= 5)]
    return prof/prof.mean()

def season_factor(prof, t_min, tau_min):
    """(1/tau) * integral of the seasonal variance multiplier over [t, t+tau] (tau <= 2 weeks). Vectorised."""
    per_min = np.repeat(np.tile(prof, 3), 60)                  # 3 weeks of minutes
    cum = np.concatenate([[0.0], np.cumsum(per_min)])
    t = np.asarray(t_min, dtype=np.int64); tau = np.asarray(tau_min, dtype=np.int64)
    rel = how_of(t)*60 + (t % 60)                                # minute-of-week of t
    return (cum[rel + tau] - cum[rel])/np.maximum(tau, 1)

# ---------------- kernels: P(S_T > K) ----------------
def p_normal(lnSK, sd):
    """BS digital, r=b=0: N(d2), d2 = (ln(S/K) - sd^2/2)/sd, sd = sigma*sqrt(tau)."""
    return ndtr((lnSK - 0.5*sd*sd)/sd)
def p_driftless(lnSK, sd):
    """Thales on-chain odds: N(ln(S/K)/sd) (04 sec 1.3)."""
    return ndtr(lnSK/sd)
def p_student(lnSK, sd, nu):
    """Variance-matched Student-t on log-return, median -sd^2/2."""
    sc = np.sqrt((nu-2)/nu)
    return stdtr(nu, (lnSK - 0.5*sd*sd)/(sd*sc))
def p_gc(lnSK, sd, g1, g2):
    """Gram-Charlier A (skew g1, excess kurt g2) on standardised log-return, clipped to [0,1]."""
    k = -(lnSK - 0.5*sd*sd)/sd      # standardized threshold
    phi = np.exp(-0.5*k*k)/np.sqrt(2*np.pi)
    p = ndtr(-k) + phi*(g1/6*(k*k-1) + g2/24*(k**3-3*k))
    return np.clip(p, 0, 1)
