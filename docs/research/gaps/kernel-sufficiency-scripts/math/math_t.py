"""(c) Which proven properties survive a variance-matched Student-t kernel. Numerical companions to the lemmas."""
import numpy as np
from scipy.special import stdtr, ndtr
from scipy.stats import t as tdist, norm, invgamma
from scipy.optimize import brentq, minimize_scalar
from scipy import integrate
np.set_printoptions(linewidth=160)
def F(nu, d): return ndtr(d) if nu is None else stdtr(nu, d*np.sqrt(nu/(nu-2)))
def f(nu, d):
    if nu is None: return norm.pdf(d)
    c = np.sqrt(nu/(nu-2)); return c*tdist.pdf(d*c, nu)
print('=== 1. kernel differences (variance-matched, probability units)')
d = np.linspace(-6, 6, 120001)
for a, b in ((None, 5), (None, 4), (None, 6), (None, 3.5), (3.5, 4), (4, 5), (5, 6), (3.8, 4)):
    diff = F(a, d) - F(b, d); i = np.argmax(np.abs(diff))
    print(f'  max |F_{a or "N"} - F_{b}| = {abs(diff[i])*100:.3f} pp at d = {d[i]:+.3f}')
dz = np.linspace(0.01, 8, 80000); sg = np.sign(F(None, dz) - F(5, dz)); print('  crossing points of F_N and F_t5 on d>0:', np.round(dz[np.where(np.diff(sg) != 0)[0]], 3))
print('\n=== 2. Lemma M analogue: g+(d) = F(d) + k f(d)')
print('  normal: g+\' = phi(d)(1 - k d) -> decreasing on d > 1/k for EVERY k > 0; Mills (1-Phi(d) < phi(d)/d) keeps g+ > 1 there.')
print('  t_vm:   g+\' = f(d)(1 - k (nu+1) d/(nu-2+d^2)); max_d (nu+1)d/(nu-2+d^2) = (nu+1)/(2 sqrt(nu-2)) at d = sqrt(nu-2)')
for nu in (3.5, 4, 5, 6):
    ks = 2*np.sqrt(nu-2)/(nu+1)
    # tail vs k f: t has (1-F)/f ~ d/nu -> Mills fails for large d
    dd = np.array([2, 5, 10, 50.0]); mr = (1-F(nu, dd))/f(nu, dd)
    # for k > k*, dip: local max d1, local min d2 of g+ (roots of k(nu+1)d = nu-2+d^2)
    rows = []
    for k in (0.6, 0.8, 1.0, 1.5, 2, 3, 5, 10, 20):
        if k <= ks: continue
        disc = (k*(nu+1))**2 - 4*(nu-2); d1 = (k*(nu+1) - np.sqrt(disc))/2; d2 = (k*(nu+1) + np.sqrt(disc))/2
        g1 = F(nu, d1) + k*f(nu, d1); g2 = F(nu, d2) + k*f(nu, d2)
        rows.append(f'k={k:g}: d1={d1:.2f} g+(d1)={g1:.4f} d2={d2:.2f} g+(d2)={g2:.4f}')
    # smallest k > k* where the dip minimum falls below 1 - p_min (p_min = 0.02)
    def dipmin(k):
        disc = (k*(nu+1))**2 - 4*(nu-2); d2 = (k*(nu+1) + np.sqrt(disc))/2; return F(nu, d2) + k*f(nu, d2)
    kk = np.linspace(ks*1.0001, 200, 200000); dm = np.array([dipmin(k) for k in kk[::50]])
    print(f'  nu={nu}: k* = 2 sqrt(nu-2)/(nu+1) = {ks:.4f}; f(0) = {f(nu,0):.4f}; k*·f(0) = {ks*f(nu,0):.4f}; Mills ratio (1-F)/f at d=2,5,10,50: {np.round(mr,3)} (~d/(nu-1)... grows)')
    print(f'      min over k in (k*,200] of dip minimum g+(d2) = {dm.min():.4f} (>= 1 - p_min = 0.98 ? {dm.min() >= 0.98}); ' + '; '.join(rows[:4]))
print('  normal comparison: k·phi(0) at k = k*_5:', round(0.5774*norm.pdf(0), 4))
print('\n=== 3. Mixed spec (t mid, normal-phi gamma term, as in engine.py): g+ = F_t(d) + k phi(d)')
for nu in (4, 5):
    for k in (0.05, 0.1, 0.3, 1.0):
        dd = np.linspace(0, 40, 400001); g = F(nu, dd) + k*norm.pdf(dd); dec = np.diff(g) < 0
        if dec.any():
            i = np.argmax(dec); j = len(dec) - np.argmax(dec[::-1]) - 1
            print(f'  nu={nu} k={k}: decreasing on d in [{dd[i]:.2f}, {dd[j]:.2f}], g+ min after dip = {g[j+1]:.5f}')
        else: print(f'  nu={nu} k={k}: monotone')
print('\n=== 4. Discrete geometric-Asian binary under a t kernel')
# Settlement: average of n = w/Delta left-endpoint log-price samples over [T-w, T]; quote at tau >= w (+cutoff) to expiry.
def asian_mu_v(x, sig, tau, w, Dl):
    n = int(round(w/Dl)); a = (tau - w) + (n-1)*Dl/2; v = (tau - w) + Dl*(n-1)*(2*n-1)/(6*n)
    return x - 0.5*sig*sig*a, sig*sig*v, sig*sig*a
YR = 365*24*3600.0
# 4a: Gaussian scale mixture (forecast-vol uncertainty): given V ~ InvGamma(nu/2, scale=(nu-2)/2) (E V = 1), path is GBM with var sig^2 V.
def exact_mix(x, sig, tau, w, Dl, nu):
    mu1, v, sa = asian_mu_v(x, sig, tau, w, Dl)
    g = lambda V: ndtr((x - 0.5*V*sa)/np.sqrt(V*v))*invgamma.pdf(V, nu/2, scale=(nu-2)/2)
    return integrate.quad(g, 0, np.inf, limit=400, epsabs=1e-13)[0]
def t_asian(x, sig, tau, w, Dl, nu):
    mu1, v, sa = asian_mu_v(x, sig, tau, w, Dl); return F(nu, mu1/np.sqrt(v))
def t_euro(x, sig, tau, nu):
    s2 = sig*sig*tau; return F(nu, (x - 0.5*s2)/np.sqrt(s2))
w = 1800.0; Dl = 12.0
for tau_h, lab in ((1.0 + 35/60, '1h market at cutoff (tau = w + 5 min + 30 min -> tau=95 min)'), (24.0, '1d market at listing'), (35/60 + 0.0, 'at cutoff tau = w + 5 min')):
    tau = tau_h*3600/YR
    for nu in (4, 5):
        errs = []; gaps = []
        for sig in (0.3, 0.6, 1.0):
            sd = sig*np.sqrt(tau)
            for z in np.linspace(-3, 3, 25):
                x = z*sd
                e = t_asian(x, sig, tau, w/YR, Dl/YR, nu) - exact_mix(x, sig, tau, w/YR, Dl/YR, nu)
                errs.append(abs(e)); gaps.append(abs(t_asian(x, sig, tau, w/YR, Dl/YR, nu) - t_euro(x, sig, tau, nu)))
        print(f'  {lab}, nu={nu}: max |t-Asian closed form - exact mixture| = {max(errs)*100:.4f} pp; max |t-Asian - t-European| = {max(gaps)*100:.2f} pp')
# 4b: MC check of the mixture result and the iid-t-increment alternative (CLT -> normal)
rng = np.random.default_rng(5)
def mc(x, sig, tau, w, Dl, nu, model, N=400000):
    n = int(round(w/Dl)); m0 = int(round((tau - w)/Dl))     # steps before window
    dt = Dl
    if model == 'mix':
        V = invgamma.rvs(nu/2, scale=(nu-2)/2, size=N, random_state=rng)
        s = sig*np.sqrt(V)
        pre = x - 0.5*s*s*(tau - w) + s*np.sqrt(tau - w)*rng.standard_normal(N)
        # window: left-endpoint samples L_0..L_{n-1}; average = L_0 + sum_{j} (n-j)/n * incr_j  (increments j=1..n-1)
        k = np.arange(1, n); wts = (n - k)/n
        var_w = (wts**2).sum()*dt; drift_w = wts.sum()*dt
        G = pre - 0.5*s*s*drift_w + s*np.sqrt(var_w)*rng.standard_normal(N)
        return (G > 0).mean()
    else:  # iid variance-matched t increments per 12 s block (GBM-like drift correction per step)
        c = np.sqrt((nu-2)/nu); tot = m0 + n - 1
        # simulate in chunks
        acc = 0; done = 0
        while done < N:
            b = min(20000, N - done)
            inc = sig*np.sqrt(dt)*c*rng.standard_t(nu, size=(b, tot)) - 0.5*sig*sig*dt
            L = x + np.cumsum(inc, axis=1)
            pre = L[:, m0-1] if m0 > 0 else np.full(b, x)
            win = np.concatenate([pre[:, None], L[:, m0:m0+n-1]], axis=1)
            acc += (win.mean(1) > 0).sum(); done += b
        return acc/N
tau = 24*3600/YR; sig = 0.6; sd = sig*np.sqrt(tau)
print('  MC check (1 d, sigma 0.6, w 30 min, 12 s):  z | mixture MC | t-Asian closed form | normal-Asian | iid-t-increment MC')
for z in (-1.5, -0.5, 0.5, 1.5):
    x = z*sd; mu1, v, sa = asian_mu_v(x, sig, tau, w/YR, Dl/YR)
    pm = mc(x, sig*1.0, tau*YR, w, Dl, 5, 'mix'); pm = pm  # (time in seconds, sigma per sqrt(second) below)
    print(f'   {z:+.1f} | ', end='')
    sig_s = sig/np.sqrt(YR)
    pm = mc(x, sig_s, tau*YR, w, Dl, 5, 'mix'); pi_ = mc(x, sig_s, tau*YR, w, Dl, 5, 'iid', N=20000)
    print(f'{pm:.4f} | {t_asian(x, sig, tau, w/YR, Dl/YR, 5):.4f} | {ndtr(mu1/np.sqrt(v)):.4f} | {pi_:.4f} (SE ~{np.sqrt(pi_*(1-pi_)/20000):.4f})')
