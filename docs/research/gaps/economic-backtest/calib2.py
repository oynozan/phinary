"""E1 calibration tests (under P) of the hook mid at quote time, OOS 2024-01..2026-09: one random strike per non-overlapping listing
(independent samples). HL with g=10 bins and df=10 (pre-specified probabilities), Spiegelhalter Z, calibration-in-the-large, ECE."""
import numpy as np, lib, bt, engine as E
from scipy.stats import chi2, norm
from scipy.special import stdtr
rng = np.random.default_rng(0)
A = bt.A
def test(tn, tenor, kernel, sig, seas, vm=1.0, period=('2024-01-01', '2026-09-24'), step=None):
    a, b = lib.minute_of(period[0]), lib.minute_of(period[1]) - tenor - 1
    t0 = np.arange(a, b, step or tenor)
    k = rng.uniform(-1.5, 1.5, len(t0))
    sdr = A['ewma1440'][t0]*np.sqrt(tenor/lib.MPY)
    lnS = A['pool'][t0]; lnK = lnS + k*sdr
    s = np.clip(vm*A[sig][t0], 0.3, 2.0); var = s*s*tenor/lib.MPY
    if seas:
        yi = E.year_index(t0); rel = lib.how_of(t0)*60 + (t0 % 60)
        var = var*(A['SC'][yi, rel+tenor] - A['SC'][yi, rel])/tenor
    sd = np.sqrt(var)
    if kernel == 'normal': p = lib.p_normal(lnS - lnK, sd)
    else:
        nu = bt.NU[tenor]; p = lib.p_student(lnS - lnK, sd, nu)
    o = (A['pool'][t0 + tenor] > lnK).astype(float)
    m = (p > 0.02) & (p < 0.98); p, o = p[m], o[m]
    n = len(p); q = np.quantile(p, np.linspace(0, 1, 11)); bins = np.clip(np.searchsorted(q, p, side='right') - 1, 0, 9)
    hl = 0; worst = 0; worst_z = 0
    for g in range(10):
        mm = bins == g; ng = mm.sum(); e = p[mm].sum(); ob = o[mm].sum(); pb = e/ng
        hl += (ob - e)**2/(ng*pb*(1-pb)); d = (ob - e)/ng; se = np.sqrt(pb*(1-pb)/ng)
        if abs(d) > abs(worst): worst = d; worst_z = d/se
    Z = np.sum((o - p)*(1 - 2*p))/np.sqrt(np.sum((1 - 2*p)**2*p*(1 - p)))
    citl = np.sum(o - p)/np.sqrt(np.sum(p*(1 - p)))
    ece = np.mean([abs(o[bins == g].mean() - p[bins == g].mean()) for g in range(10)])
    return n, hl, chi2.sf(hl, 10), Z, citl, ece, worst, worst_z
print('tenor kernel sigma seas | n  HL  p(df=10)  SpiegelhalterZ  CITL  ECE(pp)  worst-bin(pp) z | PASS? (HL p>0.01, |Z|<2.58, |CITL|<2.58, worst |z|<3)')
for tn, tenor in (('1h', 60), ('4h', 240), ('1d', 1440), ('7d', 10080)):
    for kern, sig, seas in (('normal', 'ewma1440', 0), ('normal', 'ewma240', 1), ('t', 'ewma240', 1), ('t', 'ewma1440', 0), ('normal', 'dvol', 0), ('t', 'dvol', 0)):
        n, hl, pv, Z, citl, ece, w, wz = test(tn, tenor, kern, sig, seas, step=None if tenor >= 60 else None)
        ok = pv > 0.01 and abs(Z) < 2.58 and abs(citl) < 2.58 and abs(wz) < 3
        print(f"{tn:>3} {kern:>6} {sig:>8} {seas} | {n:6d} {hl:7.1f} {pv:8.4f} {Z:+6.2f} {citl:+6.2f} {100*ece:5.2f} {100*w:+6.2f} {wz:+5.1f} | {'PASS' if ok else 'FAIL'}")
