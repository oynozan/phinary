"""
04 - LP P&L theory checks by Monte Carlo.
 (a) martingale: E[P_T]=P_0 and sum E[dP^2] = P0(1-P0)  (model-free "total quadratic variation" identity)
 (b) stale-oracle arbitrage (LVR analogue) with block-reset linear impact lambda and half-spread s:
       per-block LP loss = ((|gap|-s)^+)^2 / (2 lambda),  sum E[gap^2]/(2 lambda) ~= P0(1-P0)/(2 lambda) when s=0
 (c) noise flow revenue s*V and LP P&L distribution (noise + arbs)
 (d) no-impact (flat price) + per-block cap Q: loss grows like Q*sqrt(#blocks)
 (e) pin-risk profile: share of QV in the last h; per-block price std near expiry
"""
import numpy as np
from scipy.stats import norm
from math import sqrt, log, pi, asin

rng = np.random.default_rng(7)
YEAR = 365 * 86400


def P(S, K, sig, tau):
    tau = np.maximum(tau, 1e-300)
    d2 = (np.log(S / K) - 0.5 * sig**2 * tau) / (sig * np.sqrt(tau))
    return norm.cdf(d2)


def sim(npaths, S0, K, sig, Tsec, dt=12, lam=None, s=0.0, noise_rate=0.0, noise_mean=0.0, Qcap=None, stale_blocks=1):
    nb = int(Tsec // dt)
    S = np.full(npaths, float(S0))
    hist = [S.copy() for _ in range(stale_blocks)]
    lp_cash = np.zeros(npaths)          # LP cash P&L
    inv = np.zeros(npaths)              # LP net YES inventory (+ = LP long YES)
    arb_edge = np.zeros(npaths)         # sum of arb profit vs fair
    noise_edge = np.zeros(npaths)       # sum of noise-trader loss vs fair (LP revenue)
    qv = np.zeros(npaths)
    Pprev = P(S, K, sig, Tsec / YEAR)
    P0 = Pprev.copy()
    for k in range(1, nb + 1):
        z = rng.standard_normal(npaths)
        S = S * np.exp(-0.5 * sig**2 * dt / YEAR + sig * sqrt(dt / YEAR) * z)
        tau = (Tsec - k * dt) / YEAR
        if k == nb:
            fair = (S > K).astype(float)
        else:
            fair = P(S, K, sig, tau)
        qv += (fair - Pprev) ** 2
        Pprev = fair
        if k == nb:
            break
        S_or = hist[0]                          # oracle price (stale by `stale_blocks`)
        hist = hist[1:] + [S.copy()]
        quote = P(S_or, K, sig, tau)
        gap = fair - quote
        # --- arbitrageur
        if lam is not None:
            q = np.maximum(np.abs(gap) - s, 0) / lam
        elif Qcap is not None:
            q = np.where(np.abs(gap) > s, Qcap, 0.0)
        else:
            q = 0
        sgn = np.sign(gap)
        if lam is not None:
            profit = (np.maximum(np.abs(gap) - s, 0)) ** 2 / (2 * lam)
        else:
            profit = q * np.maximum(np.abs(gap) - s, 0)
        # arb buys YES (sgn>0) -> LP short YES
        # simpler accounting: LP cash += quantity * average execution price (signed); inventory -= signed qty
        avg_px = quote + sgn * s + (sgn * lam * q / 2 if lam is not None else 0)
        lp_cash += sgn * q * avg_px
        inv -= sgn * q
        arb_edge += profit
        # --- noise traders (arrive after arb; trade at refreshed-by-arb? assume at quote +- s, no impact)
        if noise_rate > 0:
            arrive = rng.random(npaths) < noise_rate
            qn = rng.exponential(noise_mean, npaths) * arrive
            sn = np.where(rng.random(npaths) < 0.5, 1.0, -1.0)
            px = fair + sn * s          # noise trades at fair +- s (arb already aligned quote)
            lp_cash += sn * qn * px
            inv -= sn * qn
            noise_edge += qn * s
    payoff = (S > K).astype(float)
    lp_pnl = lp_cash + inv * payoff
    return dict(P0=P0, qv=qv, lp=lp_pnl, arb=arb_edge, noise=noise_edge, payoff=payoff)


if __name__ == "__main__":
    S0, K, sig = 4000.0, 4000.0, 0.8
    T = 86400
    print("=== (a) martingale & total QV identity: 1-day ATM, 12s blocks ===")
    r = sim(20000, S0, K, sig, T)
    p0 = r['P0'][0]
    print(f"P0={p0:.6f}  E[payoff]={r['payoff'].mean():.6f} (se {r['payoff'].std()/sqrt(20000):.4f})   "
          f"E[sum dP^2]={r['qv'].mean():.6f} (se {r['qv'].std()/sqrt(20000):.5f})  P0(1-P0)={p0*(1-p0):.6f}")

    print("\n=== (b) stale-by-1-block oracle, block-reset linear impact lambda (price per token) ===")
    for lam, s in [(1e-6, 0.0), (1e-6, 0.002), (1e-6, 0.005), (1e-6, 0.01)]:
        r = sim(20000, S0, K, sig, T, lam=lam, s=s)
        pred0 = p0 * (1 - p0) / (2 * lam)
        print(f"lambda={lam:g} s={s:.3f}: E[arb profit]={r['arb'].mean():,.0f} USDC (se {r['arb'].std()/sqrt(20000):,.0f}); "
              f"E[LP P&L]={r['lp'].mean():,.0f} (se {r['lp'].std()/sqrt(20000):,.0f}); s=0 bound P0(1-P0)/(2 lambda)={pred0:,.0f}")

    print("\n  effect of oracle staleness (lambda=1e-6, s=0.002): stale_blocks = 1, 5, 25, 150(=30min TWAP-like lag)")
    for sb in [1, 5, 25, 150]:
        r = sim(5000, S0, K, sig, T, lam=1e-6, s=0.002, stale_blocks=sb)
        print(f"  stale={sb:>3} blocks ({sb*12/60:.1f} min): E[arb profit]={r['arb'].mean():,.0f} USDC")

    print("\n=== (c) noise + arbs: break-even noise volume ===")
    for rate, mean in [(0.1, 500), (0.3, 500), (0.3, 2000)]:
        r = sim(10000, S0, K, sig, T, lam=1e-6, s=0.005, noise_rate=rate, noise_mean=mean)
        vol = rate * mean * (T / 12)
        print(f"noise {rate}/block x {mean} tok (E vol {vol:,.0f} tok): E[noise rev]={r['noise'].mean():,.0f}  E[arb]={r['arb'].mean():,.0f}  "
              f"E[LP]={r['lp'].mean():,.0f} (se {r['lp'].std()/sqrt(10000):,.0f}), sd[LP]={r['lp'].std():,.0f}, "
              f"P(LP<0)={np.mean(r['lp']<0):.3f}, 1%-quantile={np.quantile(r['lp'],0.01):,.0f}")

    print("\n=== (d) flat price (no impact) with per-block cap Q, s=0.002: loss ~ Q * sum E(|gap|-s)^+ ===")
    for Th in [1, 24]:
        r = sim(5000, S0, K, sig, Th * 3600, Qcap=1000, s=0.002)
        print(f"T={Th}h: E[arb profit]={r['arb'].mean():,.1f} USDC for Q=1000 tokens/block")

    print("\n=== (e) pin-risk profile (ATM, r=0, small sig sqrtT): share of total QV in last h = 1 + (2/pi) asin(h/T - 1) ===")
    for frac in [0.001, 0.01, 0.05, 0.1, 0.25, 0.5]:
        print(f"last {frac*100:5.1f}% of life -> {1 + 2/pi*asin(frac-1):.3f} of the variance / LVR")
    print("\nper-block (12s) fair-price std at the money, n(0) sqrt(dt/tau):")
    for tau in [60, 300, 900, 3600, 4 * 3600, 86400]:
        print(f"  tau={tau/60:>6.0f} min: {norm.pdf(0)*sqrt(12/tau):.4f}")
    print("time-to-expiry below which ATM per-block std exceeds half-spread s: tau* = dt (n(0)/s)^2")
    for s in [0.005, 0.01, 0.02, 0.05]:
        print(f"  s={s}: tau* = {12*(norm.pdf(0)/s)**2/3600:.2f} h")
