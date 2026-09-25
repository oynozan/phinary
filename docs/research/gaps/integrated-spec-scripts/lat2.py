"""Sub-minute latency charge under the integrated spec (1-second Binance data 2026-06-01..2026-09-24, 5 bp band-follower pool).
Per block: start-of-block oracle, I reset, per-epoch cap Q_epoch; discrete-Asian mid with mode-A sigma fixed at creation
(RV on a 300 s grid over 3 days of the 1-s pool, x3/2, + beta, clamp); TWAP settlement over [T-w, T) sampled at block ends;
ladder + per-market budget, settlement OI cap and clairvoyant manipulation charge all on. Latency agent + noise only.
Output: per-series latency contribution (B units) = LP(lat+noise) - LP(noise), split into own P&L and crowd-out."""
import numpy as np, zipfile, glob, os, sys, json, pickle
import spec, engine as E, engine2 as E2
CACHE = 'out/s1.npz'
if not os.path.exists(CACHE):
    ts = []; px = []
    for f in sorted(glob.glob('data/s1/ETHUSDT-1s-*.zip')):
        z = zipfile.ZipFile(f); raw = z.read(z.namelist()[0]).decode().splitlines()
        a = np.array([(int(l.split(',')[0]), float(l.split(',')[4])) for l in raw if l and l[0].isdigit()])
        ts.append(a[:, 0]); px.append(a[:, 1])
    ts = np.concatenate(ts); px = np.concatenate(px); ts = np.where(ts > 1e14, ts // 1000, ts).astype(np.int64)
    o = np.argsort(ts); ts = ts[o]; px = px[o]
    n = int((ts[-1] - ts[0]) // 1000 + 1); g = np.full(n, np.nan); g[(ts - ts[0]) // 1000] = px
    for i in range(1, n):
        if np.isnan(g[i]): g[i] = g[i - 1]
    np.savez(CACHE, cex=np.log(g), t0ms=ts[0])
Z = np.load(CACHE); cex = Z['cex']; n = len(cex)
import lib
pool = lib.band_path(cex, 5e-4)
# mode-A sigma per second (causal): 300 s windows of the 1-s pool, 864-window RV x 3/2 + beta, clamp
H = 300; nk = n // H
Dk = pool[:nk * H].reshape(nk, H).mean(1)
r = np.clip(np.diff(Dk), -spec.WINSOR_TICKS * spec.LN1, spec.WINSOR_TICKS * spec.LN1)
Q = np.concatenate([[0.0], np.cumsum(r * r)])
tt = np.arange(n); j = np.maximum(tt // H - 1, 0); j0 = np.maximum(j - spec.W_WIN, 0); nn = np.maximum(j - j0, 1)
v3 = 1.5 * (Q[j] - Q[j0]) / (H * nn) * spec.YEAR_S + spec.beta_yr()
sigA_modeA = np.sqrt(np.clip(v3, spec.SIG_FLOOR ** 2, spec.SIG_CAP ** 2))
# frozen-spec sigma: live EWMA (half-life 1 d) of the same winsorised TWAP-return squared differences, x3/2 + beta
from scipy.signal import lfilter as _lf
_lam = 0.5 ** (H / 86400); _e, _ = _lf([1 - _lam], [1, -_lam], r * r, zi=[_lam * (r[:864] ** 2).mean()])
_v = 1.5 * _e / H * spec.YEAR_S + spec.beta_yr()
_j = np.clip(tt // H - 2, 0, len(_v) - 1)
sigA = np.sqrt(np.clip(_v[_j], spec.SIG_FLOOR ** 2, spec.SIG_CAP ** 2))
# strike reference: 1-day EWMA of 1-minute returns (as in the original lat1s)
from scipy.signal import lfilter
r2 = np.diff(cex[::60]) ** 2; lam_ = 0.5 ** (1 / 1440); vv, _ = lfilter([1 - lam_], [1, -lam_], r2, zi=[lam_ * r2[:1440].mean()])
sgm = np.sqrt(np.repeat(np.concatenate([[r2[:1440].mean()], vv]), 60)[:n] * 525600)
KS = np.array([-1.5, -1, -0.5, 0, 0.5, 1, 1.5])
TEN = 86400
t0 = np.arange(86400 * 3 + 8 * 3600, n - TEN - 2, 86400).astype(np.int64)
lnK = np.ascontiguousarray(pool[t0][:, None] + KS[None, :] * (sgm[t0] * np.sqrt(TEN / spec.YEAR_S))[:, None])
CC = pickle.load(open('out/costcurves.pkl', 'rb'))

def cut_s(c):
    w_s = c['w'] * 60; dt = spec.CHAIN[c['chain']]['dt_s']
    return {'wb': spec.cut_window(w_s), 'c10': spec.cut_tenor10(TEN, w_s), 'c05': spec.cut_05(c['h0'], w_s, dt)}[c['cut']]

def run(c, D, lat):
    ch = spec.CHAIN[c['chain']]; B = c['B_usd']; blk = int(ch['dt_s'])
    cs = int(np.ceil(cut_s(c) / blk) * blk)
    nsteps = TEN - cs
    nq = c['noise_usd'] / B; npr = min(D / nq / nsteps, 1.0)
    P = np.array([c['h0'], spec.C_DELTA, spec.GAMMA0, spec.C_LAG, ch['dt_s'] / spec.YEAR_S,
                  c['lam_block'], cs, spec.PMIN, c['w'] * 60, blk, blk / spec.YEAR_S,
                  1.0, c['Bs'], ch['c_manip'] / B, 1.0, 1.0, nq, npr,
                  lat, 0, 0, 0, 0, {'normal': 0, 't': 2}[c.get('kernel', 'normal')], np.sqrt(3 / 5), c.get('ramp_h', 0.0), 1, 1.0 / spec.YEAR_S, blk,
                  0.001, 0.005, 0.005, 0.02, 0.25, c['lam_block'], 0.0, 1], dtype=np.float64)
    qs = np.array([spec.q_safe_binary(c['chain'], c['w'] * 60, s, cs, c['h0']) for s in sigA[t0]]) / B
    g, C = CC[(c['chain'], c['w'])]
    out = np.zeros((len(t0), 11)); st = np.zeros((len(t0), 6))
    Qt = np.zeros((8, len(E.BUCKETS), len(E.LEV)))
    E2.run_series(t0, lnK, TEN, cex, pool, sigA, sigA, E.t_table(5.0), Qt, np.zeros(len(t0), np.int64), P, 3, out, st,
                  sigA, np.zeros(n + 1), qs, g.copy(), np.where(np.isfinite(C), C, 1e30) / B, np.zeros(1))
    return out, st

def lat_charge(c, D):
    o0, _ = run(c, D, 0); o1, st = run(c, D, 1)
    own = o1[:, 9]; crowd = o1[:, 10] - o0[:, 10]; tot = o1[:, 0] - o0[:, 0]
    return dict(total=tot.mean(), se=tot.std() / np.sqrt(len(tot)), own=own.mean(), crowd=crowd.mean(), vol=o1[:, 2].mean(),
                noise_pnl=o0[:, 0].mean(), binds=st.sum(0).tolist(), n=len(tot))

if __name__ == '__main__':
    print('seconds', n, 'days', n / 86400, 'listings', len(t0), 'sigma modeA at listings: median %.2f' % np.median(sigA[t0]))
    base = dict(chain='L1', w=120, cut='wb', h0=0.01, lam_block=0.1, B_usd=20000.0, Bs=3.0, noise_usd=1000.0)
    for ch in ('L1', 'L2'):
        c = dict(base, chain=ch)
        print(ch, lat_charge(c, 2.0))
