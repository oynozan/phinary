"""extra live sigma variants: rv1_live (1-day TWAP-return RV, no rate limit); rv_ewma (EWMA, half-life 1 d, of the same
winsorised TWAP-return squared differences x3/2 + beta) -- both oracle-implementable (checkpoint differences)."""
import numpy as np, pickle, spec
from scipy.signal import lfilter
PR = pickle.load(open('out/prep2.pkl', 'rb'))
import lib
pool = lib.POOL; N = len(pool); H = 5
lo, hi = spec.SIG_FLOOR**2, spec.SIG_CAP**2
PR['sig_rv1_live'] = np.sqrt(np.clip(PR['v1d_pool'], lo, hi))
nk = N // H; Dk = pool[:nk*H].reshape(nk, H).mean(1)
r = np.clip(np.diff(Dk), -spec.WINSOR_TICKS*spec.LN1, spec.WINSOR_TICKS*spec.LN1); r2 = r*r
lam = 0.5**(H/1440); e, _ = lfilter([1-lam], [1, -lam], r2, zi=[lam*r2[:288*3].mean()])
v = 1.5*e/H/(1+1/50)*(1+1/1250)*spec.MPY + spec.beta_yr()
t = np.arange(N); j = np.clip(t//H - 2, 0, len(v)-1)
PR['sig_rv_ewma'] = np.sqrt(np.clip(v[j], lo, hi))
for k in ('sig_rv1_live', 'sig_rv_ewma'): print(k, np.median(PR[k][1_000_000:]))
print('ewma1440 median', np.median(np.clip(pickle.load(open('../econ/out/arrays.pkl','rb'))['ewma1440'][1_000_000:],0.3,2)))
pickle.dump(PR, open('out/prep2.pkl', 'wb'))
