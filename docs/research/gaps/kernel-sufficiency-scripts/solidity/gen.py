"""Reference vectors for the variance-matched Student-t CDF/PDF (nu = 4, 5, 6) and the normal CDF.
Reference = mpmath (60 digits) via the regularized incomplete beta, independent of the closed forms under test:
  T_nu(t) = 1 - 0.5*I_{nu/(nu+t^2)}(nu/2, 1/2) for t >= 0;  F_vm(d) = T_nu(d*sqrt(nu/(nu-2))).
Inputs are exact WAD integers; outputs stored at 1e24 scale."""
from mpmath import mp, mpf, betainc, sqrt, gamma, pi, ncdf
import random, os
mp.dps = 60
WAD = 10**18; REF = 10**24
random.seed(20260926)
def enc(vals):
    b = (32).to_bytes(32, 'big') + len(vals).to_bytes(32, 'big')
    for v in vals: b += (v % (1 << 256)).to_bytes(32, 'big')
    return b
def dump(name, vals): open(f'vectors/{name}.bin', 'wb').write(enc(vals))
def T(nu, t):
    t = mpf(t)
    if t == 0: return mpf(1)/2
    tail = betainc(mpf(nu)/2, mpf(1)/2, 0, nu/(nu + t*t), regularized=True)/2
    return 1 - tail if t > 0 else tail
def Fvm(nu, d): return T(nu, d*sqrt(mpf(nu)/(nu-2)))
def fvm(nu, d):
    c = sqrt(mpf(nu)/(nu-2)); t = d*c
    return c*gamma(mpf(nu+1)/2)/(sqrt(nu*pi)*gamma(mpf(nu)/2))*(1 + t*t/nu)**(-mpf(nu+1)/2)
ds = [i*10**15 for i in range(-12000, 12001)]                             # grid 1e-3 on [-12, 12]
ds += [random.randint(-50*WAD, 50*WAD) for _ in range(4000)]             # random wei-level on [-50, 50]
for k in range(400):                                                      # log-spaced large |d| up to 2e6
    v = int(mpf(10)**(1 + 5.3*k/399)*WAD); ds += [v, -v]
ds += [random.randint(-10**15, 10**15) for _ in range(500)] + [1, -1, 0, 7, -7]
dump('d', ds)
for nu in (4, 5, 6):
    dump(f'cdf{nu}', [int(mp.nint(Fvm(nu, mpf(d)/WAD)*REF)) for d in ds])
    dump(f'pdf{nu}', [int(mp.nint(fvm(nu, mpf(d)/WAD)*REF)) for d in ds])
dump('ncdf', [int(mp.nint(ncdf(mpf(d)/WAD)*REF)) for d in ds])
print('vectors', len(ds))
