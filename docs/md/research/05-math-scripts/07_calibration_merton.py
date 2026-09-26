"""
07 - (a) calibration of quoted YES prices vs realised outcomes (reliability, Brier/Murphy, Spiegelhalter Z, HL chi2)
     (b) power: detection of a mis-specified sigma
     (c) Merton jump-diffusion model risk for digitals priced with BS(total vol)
     (d) sample-size formulas
"""
import numpy as np
from scipy.stats import norm, chi2, poisson
from math import sqrt, log, exp, factorial

rng = np.random.default_rng(5)
YEAR = 365 * 86400


def bs_dig(S, K, sig, tau):
    return norm.cdf((np.log(S / K) - 0.5 * sig**2 * tau) / (sig * np.sqrt(tau)))


def calib(n, sig_true=0.8, sig_quote=0.8, mu=0.0, Tdays=7, bins=10):
    T = Tdays / 365
    K = 4000.0
    S0 = K * np.exp(rng.normal(0, 0.1, n))                 # spread of initial moneyness
    t = rng.uniform(0, T * 0.999, n)                        # one quote per independent path
    St = S0 * np.exp((mu - 0.5 * sig_true**2) * t + sig_true * np.sqrt(t) * rng.standard_normal(n))
    tau = T - t
    ST = St * np.exp((mu - 0.5 * sig_true**2) * tau + sig_true * np.sqrt(tau) * rng.standard_normal(n))
    p = bs_dig(St, K, sig_quote, tau)
    o = (ST > K).astype(float)
    brier = np.mean((p - o) ** 2)
    # Spiegelhalter (1986) Z: under H0 (calibrated) ~ N(0,1)
    Z = np.sum((o - p) * (1 - 2 * p)) / np.sqrt(np.sum((1 - 2 * p) ** 2 * p * (1 - p)))
    # Murphy decomposition + Hosmer-Lemeshow on deciles of p
    edges = np.quantile(p, np.linspace(0, 1, bins + 1))
    idx = np.clip(np.searchsorted(edges, p, side="right") - 1, 0, bins - 1)
    rel = res = hl = 0.0
    obar = o.mean()
    rows = []
    for b in range(bins):
        mk = idx == b
        nb = mk.sum()
        pb, ob = p[mk].mean(), o[mk].mean()
        rel += nb * (pb - ob) ** 2
        res += nb * (ob - obar) ** 2
        hl += (o[mk].sum() - p[mk].sum()) ** 2 / (p[mk].sum() * (1 - p[mk].mean()))
        rows.append((pb, ob, nb))
    rel /= n
    res /= n
    unc = obar * (1 - obar)
    return dict(brier=brier, expected_brier_if_calibrated=np.mean(p * (1 - p)), Z=Z, rel=rel, res=res, unc=unc,
                hl=hl, hl_p=1 - chi2.cdf(hl, bins - 2), rows=rows)


def merton_dig(S, K, sig, tau, lam, muJ, dJ, nmax=60):
    k = exp(muJ + 0.5 * dJ**2) - 1
    out = 0.0
    for j in range(nmax):
        w = poisson.pmf(j, lam * tau)
        v = sig**2 * tau + j * dJ**2
        d2 = (np.log(S / K) + (-lam * k - 0.5 * sig**2) * tau + j * muJ) / np.sqrt(v)
        out = out + w * norm.cdf(d2)
    return out


if __name__ == "__main__":
    print("=== (a) calibration under the pricing model (n=200k independent quotes) ===")
    r = calib(200000)
    print(f"Brier={r['brier']:.5f} (E under H0 = mean p(1-p) = {r['expected_brier_if_calibrated']:.5f}); "
          f"Murphy: REL={r['rel']:.2e} RES={r['res']:.4f} UNC={r['unc']:.4f} (Brier~REL-RES+UNC={r['rel']-r['res']+r['unc']:.5f})")
    print(f"Spiegelhalter Z={r['Z']:+.3f}   Hosmer-Lemeshow chi2={r['hl']:.2f} p={r['hl_p']:.3f}")
    for pb, ob, nb in r['rows']:
        print(f"   bin mean p={pb:.4f}  realised freq={ob:.4f}  diff={ob-pb:+.4f}  (2se={2*sqrt(max(pb*(1-pb),1e-9)/nb):.4f}, n={nb})")

    print("\n=== (b) power: quoting with the wrong sigma / ignoring drift ===")
    for sq, mu, n in [(0.7, 0.0, 20000), (0.7, 0.0, 200000), (0.6, 0.0, 20000), (0.8, 1.0, 200000), (0.8, 0.3, 200000)]:
        r = calib(n, sig_true=0.8, sig_quote=sq, mu=mu)
        print(f"true sig=0.8, quoted sig={sq}, real drift mu={mu}, n={n}: Z={r['Z']:+.2f}, HL p={r['hl_p']:.2e}, REL={r['rel']:.2e}")

    print("\n=== (c) Merton jump-diffusion vs BS with total variance (what an RV estimator sees) ===")
    sig, lam, muJ, dJ = 0.6, 10.0, -0.05, 0.08
    sig_tot = sqrt(sig**2 + lam * (muJ**2 + dJ**2))
    print(f"diffusive sigma={sig}, lambda={lam}/yr, jump mean={muJ}, jump sd={dJ} -> total vol {sig_tot:.4f}")
    for Td in [1, 7, 30]:
        tau = Td / 365
        line = []
        for kk in [0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.2]:
            K = 4000 * kk
            pm = merton_dig(4000.0, K, sig, tau, lam, muJ, dJ)
            pb = bs_dig(4000.0, K, sig_tot, tau)
            line.append(f"K/S={kk}: M={float(pm):.4f} BS={float(pb):.4f} d={float(pm-pb):+.4f}")
        print(f"T={Td:>2}d | " + " | ".join(line))
    # MC check of Merton formula
    n = 400000
    tau = 7 / 365
    k = exp(muJ + 0.5 * dJ**2) - 1
    Nj = rng.poisson(lam * tau, n)
    x = (-lam * k - 0.5 * sig**2) * tau + sig * sqrt(tau) * rng.standard_normal(n) + Nj * muJ + np.sqrt(Nj) * dJ * rng.standard_normal(n)
    print(f"MC check T=7d K/S=0.95: P={np.mean(x > log(0.95)):.4f} +- {np.std(x>log(0.95))/sqrt(n):.4f} vs formula {float(merton_dig(4000.0, 3800.0, sig, tau, lam, muJ, dJ)):.4f}")

    print("\n=== (d) sample sizes ===")
    za, zb = norm.ppf(0.975), norm.ppf(0.8)
    for delta in [0.02, 0.01, 0.005]:
        print(f"calibration bin at p~0.5: detect |freq - p| >= {delta} (alpha 5%, power 80%): n_bin = {(za+zb)**2*0.25/delta**2:,.0f}")
    for cv in [5, 20, 100]:
        print(f"LP mean P&L test: to resolve mean to +-10% of |mean| with sd/|mean| = {cv}: n = {(1.96*cv/0.1)**2:,.0f} paths")
