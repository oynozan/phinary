"""
Monte Carlo economics of the quote-function choices (real-valued; the integer rounding is
covered by quote_fuzz.py).
Run: uv run --with numpy --with scipy python quote_mc.py

Model: GBM underlying, oracle epochs of dt seconds.  In epoch k the hook quotes from the
previous epoch's closing price (start-of-block, SoB) and/or a TWAP anchor of the last n closing
prices.  A fully informed arbitrageur knows the epoch-k closing price S_k (CEX-led) and trades
the hook to the point where the marginal quote equals fair F_k = P(S_k, tau_k).  Impact is
linear with slope lam (depth l = 1/lam tokens per $1) and resets when the epoch key changes.
"""
import numpy as np
from scipy.stats import norm
from math import sqrt, log

YEAR = 365 * 86400
rng = np.random.default_rng(42)


def Pbin(x, lnK, sig, tau):
    tau = np.maximum(tau, 1e-12)
    s = sig * np.sqrt(tau / YEAR)
    d = (x - lnK - 0.5 * s * s) / s
    return norm.cdf(d), norm.pdf(d), s


def arb_profit(gap, lam, Q):
    """gap = fair - (quote incl. spread), >0 means profitable; returns profit, qty."""
    g = np.maximum(gap, 0.0)
    q = g / lam
    if Q is not None:
        q = np.minimum(q, Q)
    return q * g - lam * q * q / 2, q


def run(npaths=3000, T=86400, dt=12, sig=0.6, h0=0.003, lam=1e-5, Q=None, rule="sob", n=5,
        cgam=0.0, gamma0=5.5e-4, rho=0.0, cutoff=1800, sub=1, reset_every=1, seed=1):
    """rule in {'sob','twap','dual'}; rho = carry of impact across epochs (0 reset, 1 permanent);
    sub = sub-blocks per oracle epoch with impact reset per sub-block (key finer than oracle);
    reset_every = impact reset only every m oracle epochs (key coarser than oracle)."""
    r = np.random.default_rng(seed)
    nb = int(T // dt)
    lnK = 0.0
    x = np.zeros(npaths)
    hist = [x.copy() for _ in range(max(n, 1))]  # last n closing log prices
    E = np.zeros(npaths)          # carried impact state (YES-equivalent sold, tokens)
    arb = np.zeros(npaths)
    half_spread = []
    vol_arb = np.zeros(npaths)
    sd_sub = sig * sqrt(dt / sub / YEAR)
    for k in range(1, nb + 1):
        tau = T - k * dt
        if tau < cutoff:
            break
        x_sob = hist[-1]
        x_tw = np.mean(hist[-n:], axis=0)
        gam = cgam * gamma0
        if rule == "sob":
            P, ph, s = Pbin(x_sob, lnK, sig, tau)
            A = P + gam * ph / s; B = P - gam * ph / s
        elif rule == "twap":
            P, ph, s = Pbin(x_tw, lnK, sig, tau)
            A = P + gam * ph / s; B = P - gam * ph / s
        else:
            P1, ph1, s = Pbin(x_sob, lnK, sig, tau)
            P2, ph2, _ = Pbin(x_tw, lnK, sig, tau)
            A = np.maximum(P1 + gam * ph1 / s, P2 + gam * ph2 / s)
            B = np.minimum(P1 - gam * ph1 / s, P2 - gam * ph2 / s)
        a = A + h0; b = B - h0
        half_spread.append(np.mean((a - b) / 2))
        # impact state at epoch start
        if reset_every == 1:
            E = rho * E
        elif k % reset_every == 0:
            E = np.zeros(npaths)
        for j in range(sub):
            if sub > 1 and j > 0:
                E = np.zeros(npaths) if rho == 0 else E   # key finer than oracle: reset each sub-block
            x = x + (-0.5 * sd_sub**2) + sd_sub * r.standard_normal(npaths)
            F, _, _ = Pbin(x, lnK, sig, tau)
            # up: marginal ask at state E is a + lam*E
            pu, qu = arb_profit(F - (a + lam * E), lam, None if Q is None else np.maximum(Q - E, 0))
            pd, qd = arb_profit((b + lam * E) - F, lam, None if Q is None else np.maximum(Q + E, 0))
            arb += pu + pd
            vol_arb += qu + qd
            E = E + qu - qd
        hist = hist[1:] + [x.copy()]
    return arb.mean(), arb.std() / sqrt(npaths), float(np.mean(half_spread)), vol_arb.mean()


def P0var():
    return 0.25


if __name__ == "__main__" and "--only-a3" not in __import__("sys").argv:
    print("=== A. S-input rule vs LP arbitrage loss (L1: dt=12s, 1-day ATM, sigma=60%, l=1e5, h0=0.3c, cutoff 30 min) ===")
    print(f"{'rule':<22}{'E[arb extraction] $':>22}{'se':>8}{'avg half-spread (c)':>22}")
    base = None
    for rule, n in [("sob", 1), ("twap", 2), ("twap", 5), ("twap", 25), ("twap", 150), ("dual", 2), ("dual", 5), ("dual", 25)]:
        m, se, hs, _ = run(rule=rule, n=n)
        base = base or m
        print(f"{rule+'-'+str(n):<22}{m:>22,.0f}{se:>8,.0f}{hs*100:>22.3f}   x{m/base:.2f}")
    print("bound l*P0(1-P0)/2 (s=0) =", f"{1e5*0.25/2:,.0f}")

    print("\n=== A2. same with the gamma spread term (c_delta=1, gamma0=5.5bp) ===")
    base = None
    for rule, n in [("sob", 1), ("twap", 5), ("dual", 2), ("dual", 5)]:
        m, se, hs, _ = run(rule=rule, n=n, cgam=1.0)
        base = base or m
        print(f"{rule+'-'+str(n):<22}{m:>22,.0f}{se:>8,.0f}{hs*100:>22.3f}   x{m/base:.2f}")

    print("\n=== B. per-epoch reset vs carried (permanent / decaying) impact skew, SoB rule ===")
    base = None
    for rho in [0.0, 0.5, 0.9, 1.0]:
        m, se, hs, v = run(rule="sob", rho=rho)
        base = base or m
        print(f"rho={rho:<4} E[arb]={m:>10,.0f} (se {se:,.0f})  x{m/base:.2f}   arb volume {v:,.0f}")

    print("\n=== C. epoch key vs oracle refresh on a 1 s-timestamp chain (4h ATM market, dt=1s) ===")
    m0, se0, _, _ = run(npaths=1500, T=4 * 3600, dt=1, rule="sob")
    print(f"key == oracle epoch (block.timestamp):            E[arb]={m0:,.0f} (se {se0:,.0f})")
    m1, se1, _, _ = run(npaths=1500, T=4 * 3600, dt=1, rule="sob", sub=4)
    print(f"key finer (reset each of 4 sub-blocks/second):     E[arb]={m1:,.0f} (se {se1:,.0f})  x{m1/m0:.2f}")
    m2, se2, _, _ = run(npaths=1500, T=4 * 3600, dt=1, rule="sob", reset_every=12)
    print(f"key coarser (reset every 12 oracle epochs, L1 no.): E[arb]={m2:,.0f} (se {se2:,.0f})  x{m2/m0:.2f}")

    print("\n=== D. per-epoch cap Q with impact (SoB) ===")
    for Q in [None, 50_000, 5_000, 433]:
        m, se, hs, v = run(rule="sob", Q=Q)
        print(f"Q={str(Q):>7}: E[arb]={m:>10,.0f} (se {se:,.0f})   arb volume {v:,.0f} tokens")

    print("\n=== E. builder/last-tx manipulation of SoB (attacker shifts closing log-price by delta at cost c*delta) ===")
    # attack in one epoch: gain = max_q q*(F - a(delta)) - lam q^2/2 (capped), F = fair at true x
    sig = 0.6
    for tau_h in [24, 1]:
        tau = tau_h * 3600
        for c_name, c in [("v4 5bp mainnet ($55/1%)", 5500.0), ("v3 5bp mainnet ($773/1%)", 77300.0)]:
            P0, ph0, s = Pbin(0.0, 0.0, sig, tau)
            delta_b = ph0 / s
            q_safe = c / delta_b
            print(f"tau={tau_h}h {c_name}: Delta_bin={delta_b:.2f}/unit log, q_safe=c/Delta = {q_safe:,.0f} tokens/epoch "
                  f"(x5 = {5*q_safe:,.0f} with a 5-epoch anchor vs single-block attackers)")
            for rule, nanc in [("sob", 1), ("dual5", 5)]:
                for Q in [None, int(q_safe * nanc)]:
                    best = (0, 0)
                    for delta in np.linspace(1e-5, 0.2, 4000):
                        # attacker pushes price DOWN by delta, buys YES cheap
                        Ps, phs, _ = Pbin(-delta, 0.0, sig, tau)
                        Pt, pht, _ = Pbin(-delta / nanc, 0.0, sig, tau)
                        gam = 5.5e-4
                        A = max(Ps + gam * phs / s, Pt + gam * pht / s) if nanc > 1 else Ps + gam * phs / s
                        a = A + 0.003
                        g = P0 - a
                        if g <= 0:
                            continue
                        q = g / 1e-5 if Q is None else min(g / 1e-5, Q)
                        prof = q * g - 1e-5 * q * q / 2 - c * delta
                        if prof > best[0]:
                            best = (prof, delta)
                    print(f"    {rule:<6} Q={str(Q):>8}: max attacker profit ${best[0]:>10,.0f} at delta={best[1]*1e4:.1f} bp")


if __name__ == "__main__":
    print("\n=== A3. equal-average-spread comparison: is the shape (dual / gamma) better than a flat wider h0? ===")
    for h in [0.00395, 0.00507, 0.0083, 0.01005, 0.01099]:
        m, se, hs, _ = run(rule="sob", h0=h)
        print(f"sob flat h0={h*100:.3f}c: E[arb]={m:>8,.0f} (se {se:,.0f})  avg half-spread {hs*100:.3f}c")
