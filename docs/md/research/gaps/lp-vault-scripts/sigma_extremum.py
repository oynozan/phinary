import numpy as np
from scipy.stats import norm
def P(S,K,s,t): return norm.cdf((np.log(S/K)-0.5*s*s*t)/(s*np.sqrt(t)))
t=7/365
for S,K in [(4800,5000),(4000,5000),(5200,5000)]:
    sig=np.linspace(0.05,3,300001); p=P(S,K,sig,t); i=p.argmax()
    ss = np.sqrt(2*np.log(K/S)/t) if S<K else float('nan')
    print(f"S={S} K={K}: argmax_sigma={sig[i]:.4f} max P={p[i]:.6f}; closed form sigma*={ss:.4f} P*={norm.cdf(-np.sqrt(2*np.log(K/S))) if S<K else float('nan'):.6f}; monotone decreasing? {bool(np.all(np.diff(p)<=0))}")
