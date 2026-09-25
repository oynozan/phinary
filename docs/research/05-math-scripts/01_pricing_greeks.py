"""
01 - Binary cash-or-nothing pricing, Greeks, limits, extremal values.
High-precision reference with mpmath (50 digits).
"""
import mpmath as mp
mp.mp.dps = 50

YEAR = mp.mpf(365)  # ACT/365 day count
N = lambda x: mp.ncdf(x)
n = lambda x: mp.npdf(x)


def d12(S, K, sig, T, r=0, b=None):
    """generalized BS: b = cost of carry (drift of S under Q), r = discount (collateral yield)."""
    if b is None:
        b = r
    S, K, sig, T, r, b = map(mp.mpf, (S, K, sig, T, r, b))
    v = sig * mp.sqrt(T)
    d1 = (mp.log(S / K) + (b + sig**2 / 2) * T) / v
    return d1, d1 - v


def yes(S, K, sig, T, r=0, b=None):
    d1, d2 = d12(S, K, sig, T, r, b)
    return mp.e**(-mp.mpf(r) * T) * N(d2)


def no(S, K, sig, T, r=0, b=None):
    d1, d2 = d12(S, K, sig, T, r, b)
    return mp.e**(-mp.mpf(r) * T) * N(-d2)


def greeks(S, K, sig, T, r=0):
    S, K, sig, T, r = map(mp.mpf, (S, K, sig, T, r))
    d1, d2 = d12(S, K, sig, T, r)
    D = mp.e**(-r * T)
    v = sig * mp.sqrt(T)
    delta = D * n(d2) / (S * v)
    gamma = -D * n(d2) * d1 / (S**2 * sig**2 * T)
    vega = -D * n(d2) * d1 / sig
    # theta = dP/dt (calendar time) = -dP/dtau
    dd2_dtau = -d1 / (2 * T) + r / v
    theta = r * D * N(d2) - D * n(d2) * dd2_dtau
    dK = -D * n(d2) / (K * v)
    return dict(delta=delta, gamma=gamma, vega=vega, theta=theta, dK=dK, d1=d1, d2=d2)


def fd_check(S, K, sig, T, r=0):
    g = greeks(S, K, sig, T, r)
    h = mp.mpf('1e-12')
    f = lambda S_=S, K_=K, s_=sig, T_=T: yes(S_, K_, s_, T_, r)
    fd = dict(
        delta=(f(S_=S * (1 + h)) - f(S_=S * (1 - h))) / (2 * S * h),
        gamma=(f(S_=S * (1 + h)) - 2 * f() + f(S_=S * (1 - h))) / (S * h)**2,
        vega=(f(s_=sig + h) - f(s_=sig - h)) / (2 * h),
        theta=-(f(T_=T + h) - f(T_=T - h)) / (2 * h),
        dK=(f(K_=K * (1 + h)) - f(K_=K * (1 - h))) / (2 * K * h),
    )
    return {k: (g[k], fd[k], abs(g[k] - fd[k]) / max(abs(fd[k]), mp.mpf('1e-40'))) for k in fd}


if __name__ == "__main__":
    print("=== Worked examples (r=0 unless stated; T in years ACT/365) ===")
    ex = [
        (4000, 5000, 0.8, 30 / YEAR, 0),
        (4000, 5000, 0.8, 30 / YEAR, 0.05),
        (4000, 4000, 0.8, 30 / YEAR, 0),
        (4000, 4400, 0.6, 7 / YEAR, 0),
        (4000, 4040, 0.6, 1 / YEAR, 0),
        (4000, 4000, 0.6, (1 / 24) / YEAR, 0),
        (4000, 4010, 0.6, (1 / 24) / YEAR, 0),
        (3000, 5000, 0.8, 97 / YEAR, 0),
    ]
    for S, K, s, T, r in ex:
        y = yes(S, K, s, T, r)
        nn = no(S, K, s, T, r)
        g = greeks(S, K, s, T, r)
        print(f"S={S} K={K} sig={s} T={float(T*365):.4f}d r={r}: d1={float(g['d1']):.6f} d2={float(g['d2']):.6f} "
              f"YES={mp.nstr(y, 12)} NO={mp.nstr(nn, 12)} YES+NO={mp.nstr(y+nn, 12)} e^-rT={mp.nstr(mp.e**(-r*T),12)}")
        print(f"     delta={mp.nstr(g['delta'],8)} (per $; x100 = per $100: {mp.nstr(100*g['delta'],6)}), gamma={mp.nstr(g['gamma'],8)}, "
              f"vega={mp.nstr(g['vega'],8)} (per 1.00 vol; per vol-pt {mp.nstr(g['vega']/100,6)}), theta/yr={mp.nstr(g['theta'],8)} "
              f"theta/day={mp.nstr(g['theta']/365,6)}")

    print("\n=== Analytic Greeks vs finite differences (rel err) ===")
    for S, K, s, T, r in [(4000, 5000, 0.8, 30 / YEAR, 0), (4000, 3500, 0.5, 3 / YEAR, 0.04), (4000, 4001, 1.2, 0.001, 0)]:
        res = fd_check(S, K, s, T, r)
        print(S, K, s, float(T), r, {k: mp.nstr(v[2], 3) for k, v in res.items()})

    print("\n=== Max delta over S = 1/(K sig sqrt(2 pi T)), attained at d1=0 i.e. S*=K exp(-(r+sig^2/2)T) ===")
    for K, s, T, r in [(5000, 0.8, 30 / YEAR, 0), (5000, 0.8, 30 / YEAR, 0.05), (4000, 0.6, 1 / YEAR, 0), (4000, 0.6, 1 / (24 * YEAR), 0)]:
        K, s, T, r = map(mp.mpf, (K, s, T, r))
        Sstar = K * mp.e**(-(r + s**2 / 2) * T)
        f = lambda S_: greeks(S_, K, s, T, r)['delta']
        Smax = mp.findroot(lambda S_: mp.diff(f, S_), Sstar * 1.001)
        print(f"K={K} sig={s} T={float(T):.6f} r={r}: numeric argmax S={mp.nstr(Smax,12)} formula S*={mp.nstr(Sstar,12)}; "
              f"max delta={mp.nstr(f(Smax),12)} formula={mp.nstr(1/(K*s*mp.sqrt(2*mp.pi*T)),12)}; "
              f"=> max price move per 1% spot move ~ {mp.nstr(f(Smax)*Sstar*0.01,6)}")

    print("\n=== Vega sign change at d1=0 (K_v = S exp((r+sig^2/2)T)); theta sign change at d1 = 2 r sqrt(T)/sig ===")
    S, s, T = mp.mpf(4000), mp.mpf(0.8), 30 / YEAR
    Kv = S * mp.e**((s**2 / 2) * T)
    for K in [Kv * 0.99, Kv, Kv * 1.01]:
        g = greeks(S, K, s, T)
        print(f"K={mp.nstr(K,10)}: d1={mp.nstr(g['d1'],6)} vega={mp.nstr(g['vega'],6)} theta={mp.nstr(g['theta'],6)}")

    print("\n=== Limits ===")
    for T in [1e-2, 1e-4, 1e-6, 1e-8, 1e-10]:
        print(f"T={T:g}: YES(S=K)={mp.nstr(yes(4000,4000,0.8,T),12)}  YES(S=1.001K)={mp.nstr(yes(4004,4000,0.8,T),8)}  YES(S=0.999K)={mp.nstr(yes(3996,4000,0.8,T),8)}")
    for s in [1, 3, 10, 30, 100]:
        print(f"sig={s}: YES(S=K,T=30d)={mp.nstr(yes(4000,4000,s,30/YEAR),10)} YES(S=2K)={mp.nstr(yes(8000,4000,s,30/YEAR),10)}")
    for s in [1e-2, 1e-4, 1e-8]:
        print(f"sig={s}: YES(S=K,r=0)={mp.nstr(yes(4000,4000,s,30/YEAR),12)} [-> 1/2]; YES(S=K, r=5%)={mp.nstr(yes(4000,4000,s,30/YEAR,0.05),12)} "
              f"[-> e^-rT={mp.nstr(mp.e**(-0.05*30/YEAR),12)} since F>K]")
    print("S->0:", mp.nstr(yes(1e-6, 4000, 0.8, 30 / YEAR), 5), " S->inf:", mp.nstr(yes(1e9, 4000, 0.8, 30 / YEAR), 12))

    print("\n=== ATM price for r=0 is N(-sig sqrt(T)/2) < 1/2 (lognormal median below mean) ===")
    for s in [0.4, 0.8, 1.2]:
        for Td in [1 / 24, 1, 7, 30, 90, 365]:
            T = mp.mpf(Td) / YEAR
            print(f"sig={s} T={Td:>8.4f}d: YES_ATM={mp.nstr(yes(4000,4000,s,T),8)}", end=" | ")
        print()

    print("\n=== Drift sensitivity: E_P[1{S_T>K}] - price(r=0), mu = real-world drift of ETH ===")
    for mu in [-0.5, 0.2, 0.5, 1.0]:
        for Td in [1, 7, 30]:
            T = mp.mpf(Td) / YEAR
            for mny in [1.0, 1.1]:
                K = 4000 * mny
                pQ = yes(4000, K, 0.8, T, 0, 0)
                pP = N(d12(4000, K, 0.8, T, 0, mu)[1])
                print(f"mu={mu:+.1f} T={Td:>2}d K/S={mny}: price={mp.nstr(pQ,6)} P-prob={mp.nstr(pP,6)} edge={mp.nstr(pP-pQ,4)}")
