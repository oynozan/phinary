"""
08 - (a) closed form E[((|X|-s)^+)^2], X~N(0,v)  (per-block arb loss with half-spread s)
     (b) MC check of the QV time-profile formula share(last h) = 1 + (2/pi) asin(h/T - 1)
     (c) oracle-manipulation break-even trade sizes and TWAP-settlement manipulation cost (first-order CPMM-in-range model)
"""
import numpy as np
from scipy.stats import norm
from math import sqrt, pi, asin, log

rng = np.random.default_rng(9)
YEAR = 365 * 86400


def e_sq_excess(v, s):
    a = s / sqrt(v)
    return 2 * ((v + s * s) * (1 - norm.cdf(a)) - s * sqrt(v) * norm.pdf(a))


if __name__ == "__main__":
    print("=== (a) E[((|X|-s)^+)^2] closed form vs MC ===")
    for v, s in [(1e-4, 0.0), (1e-4, 0.005), (1e-4, 0.02), (4e-6, 0.002)]:
        x = rng.normal(0, sqrt(v), 2_000_000)
        mc = np.mean(np.maximum(np.abs(x) - s, 0) ** 2)
        print(f"v={v:g} s={s}: closed={e_sq_excess(v,s):.4e} MC={mc:.4e}")

    print("\n=== (b) share of total quadratic variation in last fraction h/T (ATM, 1d, 12s blocks) ===")
    npaths, T, dt, sig, K = 20000, 86400, 12, 0.8, 4000.0
    nb = T // dt
    S = np.full(npaths, K)
    Pp = norm.cdf((np.log(S / K) - 0.5 * sig**2 * T / YEAR) / (sig * sqrt(T / YEAR)))
    qv = np.zeros((npaths, nb))
    for k in range(1, nb + 1):
        S = S * np.exp(-0.5 * sig**2 * dt / YEAR + sig * sqrt(dt / YEAR) * rng.standard_normal(npaths))
        tau = (T - k * dt) / YEAR
        Pn = (S > K).astype(float) if k == nb else norm.cdf((np.log(S / K) - 0.5 * sig**2 * tau) / (sig * sqrt(tau)))
        qv[:, k - 1] = (Pn - Pp) ** 2
        Pp = Pn
    tot = qv.sum(1).mean()
    for frac in [0.01, 0.1, 0.25, 0.5]:
        m = int(round(nb * frac))
        print(f"last {frac:.0%}: MC share={qv[:, -m:].sum(1).mean()/tot:.3f}  formula={1+2/pi*asin(frac-1):.3f}")

    print("\n=== (c1) spot-oracle manipulation: safe per-trade size q_safe = f * L*sqrt(S) * sigma*sqrt(tau) / n(d2) ===")
    print("   (L*sqrt(S) ~= 200 * D1, D1 = USDC needed to move the underlying pool price by 1%, CPMM-in-range approximation)")
    for D1 in [1e6, 5e6, 2e7]:
        for f in [0.0005, 0.0030]:
            row = []
            for tau_s, lab in [(7 * 86400, "7d"), (86400, "1d"), (3600, "1h"), (300, "5m")]:
                q = f * 200 * D1 * 0.8 * sqrt(tau_s / YEAR) / norm.pdf(0)
                row.append(f"{lab}: {q:>12,.0f}")
            print(f"D1=${D1:>12,.0f} fee={f*1e4:>4.0f}bp (sigma=0.8, ATM) q_safe tokens -> " + " | ".join(row))

    print("\n=== (c2) TWAP settlement manipulation, fee-band aware: C(delta) ~ L sqrt(S) [ f delta + (w/dt) (delta-f)^+ (delta+3f)/4 ] ===")
    print("   (displacements inside the +-f no-arbitrage band are not reverted by arbitrageurs -> almost free)")
    for D1 in [1e6, 5e6, 2e7]:
        for f in [0.0005, 0.0030]:
            for w_min in [5, 30]:
                row = []
                for delta in [0.0005, 0.001, 0.005]:
                    for dt_b in [12, 1]:
                        Ls = 200 * D1
                        cost = Ls * (f * delta + (w_min * 60 / dt_b) * max(delta - f, 0) * (delta + 3 * f) / 4)
                        row.append(f"d={delta*1e4:>2.0f}bp/{dt_b:>2}s:{cost:>12,.0f}")
                print(f"D1=${D1/1e6:>4.0f}M f={f*1e4:>2.0f}bp w={w_min:>2}m | " + " | ".join(row))
    print("\nprobability that the settlement statistic lands within +-delta of K (flip-able), ATM start: ~ 2 delta n(d2) / (sigma sqrt(T - 2w/3))")
    for Td in [1, 7]:
        for delta in [0.0005, 0.001]:
            print(f"T={Td}d delta={delta*1e4:.0f}bp: {2*delta*norm.pdf(0)/(0.8*sqrt(Td/365)):.4f}")
