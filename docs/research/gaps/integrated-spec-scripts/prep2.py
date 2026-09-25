"""Precompute for the integrated-spec backtest:
 - mode-A sigma series (oracle report 3.1): TWAP-return RV on a 300 s grid, x3/2, winsorised at 400 ticks, W = 864 windows
   (3 d) and 288 (1 d guard), + beta = 0.5 f^2/H, clamp [0.20, 2.50]; computed causally on the 1-minute band-follower pool.
 - walk-forward ECDF tables of the *Asian* settlement statistic (the tail agent knows the settlement rule), for each sigma
   series used as standardiser and each window w.
Output: out/prep2.pkl"""
import numpy as np, pickle, os, lib, spec
from engine import BUCKETS, LEV, YEARS
A = pickle.load(open('../econ/out/arrays.pkl', 'rb'))
pool = A['pool']; cex = A['cex']; N = len(pool)

def rv_series(logp, nwin, H=5, winsor=spec.WINSOR_TICKS * spec.LN1, beta=spec.beta_yr(), m_sim=5, m_chain=25, raw=False):
    """Per-minute causal sigma (annualised). Window k = minutes [5k, 5k+5); D_k = mean (time average of the piecewise-constant
    1-minute path); r_k = clip(D_k - D_{k-1}); v = 1.5*sum r^2/(H*n) per minute. Discreteness: Var(dA) = (2/3)s^2 H (1+1/(2m^2));
    the sim has m = 5 samples per window, the L1 chain m = 25, so divide by (1+1/50) and multiply by (1+1/1250)."""
    nk = N // H
    Dk = logp[:nk * H].reshape(nk, H).mean(1)
    r = np.clip(np.diff(Dk), -winsor, winsor)          # r[k-1] = D_k - D_{k-1}, known once window k is complete (minute 5k+5)
    Q = np.concatenate([[0.0], np.cumsum(r * r)])       # Q[j] = sum of first j differences
    # at minute t, windows complete: k <= t//5 - 1  -> differences available j = k_last = t//5 - 1
    t = np.arange(N); j = np.maximum(t // H - 1, 0)
    j0 = np.maximum(j - nwin, 0); n = np.maximum(j - j0, 1)
    v_min = 1.5 * (Q[j] - Q[j0]) / (H * n) / (1 + 1 / (2 * m_sim ** 2)) * (1 + 1 / (2 * m_chain ** 2))
    v = v_min * spec.MPY
    if raw: return v
    return v + beta

if __name__ == '__main__':
    out = {}
    v3 = rv_series(pool, spec.W_WIN); v1 = rv_series(pool, 288)
    out['v3d_pool'] = v3; out['v1d_pool'] = v1
    out['sigA_modeA'] = np.sqrt(np.clip(v3, spec.SIG_FLOOR ** 2, spec.SIG_CAP ** 2))
    out['guard_ok'] = (v1 / v3 >= 0.25) & (v1 / v3 <= 4.0)
    # beta check: pool RV (+beta) vs CEX RV with the same estimator (no beta)
    vc = rv_series(cex, spec.W_WIN, beta=0.0)
    vp_raw = rv_series(pool, spec.W_WIN, beta=0.0)
    st = lib.minute_of('2021-01-01')
    for Y in range(2021, 2027):
        a, b = lib.minute_of(f'{Y}-01-01'), (lib.minute_of(f'{Y+1}-01-01') if Y < 2026 else N - 1)
        sl = slice(a, b, 60)
        print(f'{Y}: mean var CEX {vc[sl].mean():.4f}  pool raw {vp_raw[sl].mean():.4f} ({vp_raw[sl].mean()/vc[sl].mean()-1:+.2%})  pool+beta {v3[sl].mean():.4f} ({v3[sl].mean()/vc[sl].mean()-1:+.2%})  | EWMA1d var {np.mean(A["ewma1440"][sl]**2):.4f}')
    sl = slice(st, N, 60)
    print(f'ALL 2021+: pool+beta / CEX = {v3[sl].mean()/vc[sl].mean():.4f}; raw {vp_raw[sl].mean()/vc[sl].mean():.4f}; guard fires {100*(1-out["guard_ok"][st:].mean()):.2f}% of minutes; '
          f'clamp binds low {100*(v3[st:] < .04).mean():.2f}% high {100*(v3[st:] > 6.25).mean():.3f}%')
    # ECDF tables of the Asian statistic x = (TWAP_pool[T-w,T) - lnS_t) / (sig_t*sqrt(v(h)))  (drift removed, martingale-centred)
    cs = np.concatenate([[0.0], np.cumsum(pool)])
    def tables(sig, w):
        Qt = np.zeros((len(YEARS), len(BUCKETS), len(LEV)))
        st0 = lib.minute_of('2020-02-01')
        for yi, Y in enumerate(YEARS):
            end = min(lib.minute_of(f'{max(Y,2021)}-01-01'), N - 1)
            for bi, h in enumerate(BUCKETS):
                h = max(h, w + 5)          # buckets below the legal cutoff: use the shortest legal horizon
                ts = np.arange(st0, end - h, 10)
                Tm = ts + h
                G = (cs[Tm] - cs[Tm - w]) / w
                we = (w - 1) * (2 * w - 1) / (6 * w)           # dt = 1 minute sampling in the sim
                vv = (h - w + we) / spec.MPY
                sd = sig[ts] * np.sqrt(vv)
                x = (G - cex[ts]) / sd     # beliefs are evaluated at the CEX price (agent sees CEX)
                a_std = 0.5 * sig[ts] * (h - w + (w - 1) / 2) / spec.MPY / np.sqrt(vv)
                x = x - x.mean() - np.median(a_std)
                Qt[yi, bi] = np.quantile(x, LEV)
        return Qt
    for name, sig in (('modeA', out['sigA_modeA']), ('ewma1440', A['ewma1440'])):
        for w in (30, 120, 240):
            out[f'Q_{name}_{w}'] = tables(sig, w)
            print('table', name, w, 'done', flush=True)
    pickle.dump(out, open('out/prep2.pkl', 'wb'))
