"""
02 - Bit-exact Python emulation of on-chain fixed-point building blocks and CDF approximations.
  * solady/solmate expWad (Remco Bloemen rational approx)            -> repos/solady/src/utils/FixedPointMathLib.sol:207
  * solady lnWad                                                     -> repos/solady/src/utils/FixedPointMathLib.sol:277
  * solstat Gaussian.erfc / cdf (Numerical Recipes erfcc, 1.2e-7 rel)-> repos/solstat/src/Gaussian.sol:89,183
  * float/mp versions of: Lyra (Hart/West, double precision), Premia (Choudhury), RMM-core (A&S 7.1.26)
Measures: max abs error vs mpmath, monotonicity violations (weak monotone?), symmetry/parity error,
and end-to-end d2 -> price pipeline error.
"""
import math, random, sys
import mpmath as mp
import numpy as np

mp.mp.dps = 40
WAD = 10**18
M256 = (1 << 256) - 1


def wrap(v):  # int256 two's complement wrap (EVM semantics in unchecked/assembly)
    v &= M256
    return v - (1 << 256) if v >> 255 else v


def sdiv(a, b):
    if b == 0:
        return 0
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


# ---------------- solady / solmate expWad ----------------
def expWad(x, solmate=True):
    if x <= (-42139678854452767551 if solmate else -41446531673892822313):
        return 0
    if x >= 135305999368893231589:
        raise OverflowError
    x = sdiv(x << 78, 5**18)
    k = (sdiv(x << 96, 54916777467707473351141471128) + 2**95) >> 96
    x = x - k * 54916777467707473351141471128
    y = x + 1346386616545796478920950773328
    y = ((y * x) >> 96) + 57155421227552351082224309758442
    p = y + x - 94201549194550492254356042504812
    p = ((p * y) >> 96) + 28719021644029726153956944680412240
    p = p * x + (4385272521454847904659076985693276 << 96)
    q = x - 2855989394907223263936484059900
    q = ((q * x) >> 96) + 50020603652535783019961831881945
    q = ((q * x) >> 96) - 533845033583426703283633433725380
    q = ((q * x) >> 96) + 3604857256930695427073651918091429
    q = ((q * x) >> 96) - 14423608567350463180887372962807573
    q = ((q * x) >> 96) + 26449188498355588339934803723976023
    r = sdiv(p, q)
    r = (r * 3822833074963236453042738258902158003155416615667) >> (195 - k)
    return r


# ---------------- solady lnWad ----------------
def lnWad(x):
    if x <= 0:
        raise ValueError
    r = 255 - (x.bit_length() - 1)          # 255 ^ log2(x)   (equivalent to the de Bruijn byte trick)
    x = ((x << r) & M256) >> 159             # (1,2) * 2**96
    sar = lambda s, v: wrap(v) >> s
    p = wrap(sar(96, wrap(wrap(sar(96, wrap(wrap(sar(96, wrap((3273285459638523848632254066296 + x) * x)) + 24828157081833163892658089445524) * x)) + 43456485725739037958740375743393) * x)) - 11111509109440967052023855526967)
    p = wrap(sar(96, wrap(p * x)) - 45023709667254063763336534515857)
    p = wrap(sar(96, wrap(p * x)) - 14706773417378608786704636184526)
    p = wrap(wrap(p * x) - (795164235651350426258249787498 << 96))
    q = 5573035233440673466300451813936 + x
    q = 71694874799317883764090561454958 + sar(96, wrap(x * q))
    q = 283447036172924575727196451306956 + sar(96, wrap(x * q))
    q = 401686690394027663651624208769553 + sar(96, wrap(x * q))
    q = 204048457590392012362485061816622 + sar(96, wrap(x * q))
    q = 31853899698501571402653359427138 + sar(96, wrap(x * q))
    q = 909429971244387300277376558375 + sar(96, wrap(x * q))
    p = sdiv(p, q)
    p = wrap(1677202110996718588342820967067443963516166 * p)
    p = wrap(16597577552685614221487285958193947469193820559219878177908093499208371 * (159 - r) + p)
    p = wrap(600920179829731861736702779321621459595472258049074101567377883020018308 + p)
    return p >> 174


# ---------------- solstat Gaussian ----------------
ONE, TWO = WAD, 2 * WAD
SQRT2 = 1_414213562373095048
A_, B_, C_, D_, E_ = 1_265512230000000000, 1_000023680000000000, 374091960000000000, 96784180000000000, -186288060000000000
F_, G_, H_, I_, J_ = 278868070000000000, -1_135203980000000000, 1_488515870000000000, -822152230000000000, 170872770000000000
muliWad = lambda x, y: sdiv(x * y, WAD)
diviWad = lambda x, y: sdiv(x * WAD, y)


def solstat_erfc(inp):
    if inp == 0:
        return ONE
    if inp >= 6_240000000000000000:
        return 0
    if inp <= -6_240000000000000000:
        return TWO
    z = abs(inp)
    t = diviWad(ONE, ONE + (z * WAD) // (2 * WAD))
    step = F_ + muliWad(t, G_ + muliWad(t, H_ + muliWad(t, I_ + muliWad(t, J_))))
    step = muliWad(t, B_ + muliWad(t, C_ + muliWad(t, D_ + muliWad(t, E_ + muliWad(t, step)))))
    k = (-1 * muliWad(z, z) - A_) + step
    r = muliWad(t, expWad(k))
    return TWO - r if inp < 0 else r


def solstat_cdf(x):
    inp = sdiv(x * ONE, SQRT2)
    return sdiv(solstat_erfc(-inp) * ONE, TWO)


# ---------------- float reference approximations ----------------
def hart_west(x):  # Lyra BlackScholes._stdNormalCDF algorithm (West 2005 / Hart 1968), float64
    z = abs(x)
    c = 0.0
    if z <= 37:
        e = math.exp(-z * z / 2)
        if z < 7.07106781186547:
            n = ((((((0.0352624965998911 * z + 0.700383064443688) * z + 6.37396220353165) * z + 33.912866078383) * z + 112.079291497871) * z + 221.213596169931) * z + 220.206867912376)
            d = (((((((0.0883883476483184 * z + 1.75566716318264) * z + 16.064177579207) * z + 86.7807322029461) * z + 296.564248779674) * z + 637.333633378831) * z + 793.826512519948) * z + 440.413735824752)
            c = e * n / d
        else:
            f = z + 1 / (z + 2 / (z + 3 / (z + 4 / (z + 0.65))))
            c = e / f / 2.506628274631
    return c if x <= 0 else 1 - c


def choudhury(x):  # Premia OptionMath._N
    v = math.exp(-x * x / 2) / (2260 / 3989 + 6400 / 3989 * abs(x) + 3300 / 3989 * math.sqrt(x * x + 3))
    return 1 - v if x > 0 else v


def as_7126(x):  # RMM-core CumulativeNormalDistribution.getCDF (A&S 7.1.26 erf)
    z = x / math.sqrt(2)
    t = 1 / (1 + 0.3275911 * abs(z))
    erf = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * math.exp(-z * z)
    if z < 0:
        erf = -erf
    return 0.5 * (1 + erf)


def nr_erfcc_exact(x):  # NR erfcc evaluated in 40-digit arithmetic: isolates *approximation* error from rounding error
    x = mp.mpf(x)
    z = -x / mp.sqrt(2)
    zz = abs(z)
    t = 1 / (1 + zz / 2)
    ans = t * mp.e**(-zz * zz - mp.mpf('1.26551223') + t * (mp.mpf('1.00002368') + t * (mp.mpf('0.37409196') + t * (mp.mpf('0.09678418') + t * (mp.mpf('-0.18628806') + t * (mp.mpf('0.27886807') + t * (mp.mpf('-1.13520398') + t * (mp.mpf('1.48851587') + t * (mp.mpf('-0.82215223') + t * mp.mpf('0.17087277'))))))))))
    e = ans if z >= 0 else 2 - ans
    return e / 2


if __name__ == "__main__":
    random.seed(1)
    print("=== expWad / lnWad sanity vs mpmath ===")
    worst_e = 0
    worst_l = 0
    for _ in range(20000):
        x = random.randint(-41 * WAD, 60 * WAD)
        ex = mp.e**(mp.mpf(x) / WAD) * WAD
        got = expWad(x)
        if ex > 1e3:
            worst_e = max(worst_e, abs(got - ex) / ex)
        y = random.randint(1, 10**40)
        el = mp.log(mp.mpf(y) / WAD) * WAD
        worst_l = max(worst_l, abs(lnWad(y) - el))
    print(f"expWad max rel err = {float(worst_e):.3e};  lnWad max abs err = {float(worst_l):.3f} wei")
    # monotonicity of lnWad/expWad on consecutive integers (spot checks)
    viol = 0
    for base in [WAD, 4000 * WAD // 5000, 12345678901234567, 5 * 10**17 + 3, 999999999999999999]:
        prev = lnWad(base)
        for i in range(1, 20001):
            cur = lnWad(base + i)
            if cur < prev:
                viol += 1
            prev = cur
    print("lnWad consecutive-integer decreases in 100k samples:", viol)

    print("\n=== CDF approximations: max |Phi_hat - Phi| on grid x in [-9,9] step 1e-3 ===")
    xs = np.arange(-9, 9.0000001, 1e-3)
    exact = [mp.ncdf(mp.mpf(float(x))) for x in xs]
    for name, f in [("Lyra Hart/West (f64)", hart_west), ("Premia Choudhury", choudhury), ("RMM A&S 7.1.26", as_7126)]:
        errs = [abs(f(float(x)) - float(e)) for x, e in zip(xs, exact)]
        i = int(np.argmax(errs))
        print(f"{name:28s} max abs err = {max(errs):.3e} at x={xs[i]:+.3f}")
    errs_nr = [abs(nr_erfcc_exact(float(x)) - e) for x, e in zip(xs[::10], exact[::10])]
    i = int(np.argmax(errs_nr))
    print(f"{'NR erfcc (exact arith)':28s} max abs err = {float(max(errs_nr)):.3e} at x={xs[::10][i]:+.3f}")
    sol = []
    for x, e in zip(xs, exact):
        xi = int(round(x * 1e6)) * 10**12
        sol.append(abs(solstat_cdf(xi) / WAD - e))
    i = int(np.argmax(sol))
    print(f"{'solstat cdf (bit-exact int)':28s} max abs err = {float(max(sol)):.3e} at x={xs[i]:+.3f}")

    # relative error in tails (matters for deep OTM prices)
    print("\n=== Tail behaviour: Phi(x) and approximations for deep-OTM d2 ===")
    for x in [-3, -4, -5, -6, -7, -8, -8.8, -9]:
        e = mp.ncdf(x)
        s = solstat_cdf(int(x * 1e6) * 10**12) / WAD
        print(f"x={x:+.1f}: Phi={mp.nstr(e,6)}  solstat={s:.6e} (relerr {float(abs(s-e)/e):.2e})  hart={hart_west(x):.6e}  choud={choudhury(x):.6e} (relerr {float(abs(choudhury(x)-e)/e):.2e})")

    print("\n=== Weak monotonicity of solstat cdf (bit-exact) ===")
    tot = 0
    viol = 0
    maxdrop = 0
    # (a) coarse grid over the domain
    prev = solstat_cdf(-9 * WAD)
    for i in range(1, 180001):
        x = -9 * WAD + i * 10**14
        cur = solstat_cdf(x)
        tot += 1
        if cur < prev:
            viol += 1
            maxdrop = max(maxdrop, prev - cur)
        prev = cur
    print(f"grid step 1e-4 over [-9,9]: {tot} steps, decreases={viol}, max drop={maxdrop} wei")
    # (b) consecutive wei runs
    viol = 0
    maxdrop = 0
    tot = 0
    for c in [-2.5, -1.3, -0.4, -1e-9, 0, 1e-9, 0.3, 1.1, 2.7, 4.9]:
        base = int(c * WAD)
        prev = solstat_cdf(base)
        for i in range(1, 5001):
            cur = solstat_cdf(base + i * 997)  # ~1e-15 steps
            tot += 1
            if cur < prev:
                viol += 1
                maxdrop = max(maxdrop, prev - cur)
            prev = cur
    print(f"fine steps (997 wei) near 10 centers: {tot} steps, decreases={viol}, max drop={maxdrop} wei")
    # (c) random pairs x<y
    viol = 0
    maxdrop = 0
    for _ in range(100000):
        x = random.randint(-9 * WAD, 9 * WAD)
        y = x + random.randint(1, 10**random.randint(1, 17))
        a, b = solstat_cdf(x), solstat_cdf(y)
        if b < a:
            viol += 1
            maxdrop = max(maxdrop, a - b)
    print(f"random pairs x<y: 100000, decreases={viol}, max drop={maxdrop} wei")

    print("\n=== Parity/symmetry: cdf(x)+cdf(-x) - 1 (solstat) ===")
    worst = 0
    for _ in range(50000):
        x = random.randint(0, 9 * WAD)
        worst = max(worst, abs(solstat_cdf(x) + solstat_cdf(-x) - WAD))
    print("max |cdf(x)+cdf(-x)-1| =", worst, "wei  (=> compute NO := 1e18 - YES to get exact parity)")

    print("\n=== End-to-end fixed-point pipeline error: P_hat = solstat_cdf(d2_hat), d2_hat from lnWad/isqrt/mulDiv ===")
    def d2_fixed(S, K, sig, T):  # all WAD; floor rounding everywhere
        lnSK = lnWad(S * WAD // K)
        var_T = sig * sig // WAD * T // WAD            # sigma^2 T
        vol_sqrtT = sig * math.isqrt(T * WAD) // WAD  # sigma sqrt(T) (sqrtWad = floor(sqrt(T*1e18)))
        num = lnSK - var_T // 2
        return sdiv(num * WAD, vol_sqrtT)
    worst_p = 0
    worst_case = None
    for _ in range(20000):
        S = random.uniform(1000, 10000)
        K = S * math.exp(random.uniform(-0.5, 0.5))
        sig = random.uniform(0.2, 2.0)
        T = random.uniform(60, 365 * 86400) / (365 * 86400)
        Sw, Kw, sw, Tw = int(S * 1e6) * 10**12, int(K * 1e6) * 10**12, int(sig * 1e18), int(T * 1e18)
        ph = solstat_cdf(d2_fixed(Sw, Kw, sw, Tw)) / WAD
        ex = mp.ncdf((mp.log(mp.mpf(Sw) / Kw) - (mp.mpf(sw) / WAD)**2 * (mp.mpf(Tw) / WAD) / 2) / ((mp.mpf(sw) / WAD) * mp.sqrt(mp.mpf(Tw) / WAD)))
        e = abs(ph - ex)
        if e > worst_p:
            worst_p, worst_case = e, (S, K, sig, T * 365 * 86400)
    print(f"max |P_hat - P| over 20k random (S,K,sig,T in [60s,1y]) = {float(worst_p):.3e} at S,K,sig,Tsec={worst_case}")

    print("\n=== Oracle input quantisation: using tick (1bp grid) instead of sqrtPriceX96 ===")
    for Th, lab in [(1, "1h"), (24, "1d"), (24 * 7, "7d")]:
        T = Th / (24 * 365)
        for sig in [0.4, 0.8]:
            dd2 = 0.5 * math.log(1.0001) / (sig * math.sqrt(T))   # half-tick error on ln S (floor => up to 1 tick)
            dP = dd2 / math.sqrt(2 * math.pi)
            print(f"T={lab:>3} sig={sig}: max d2 err (1 tick)={2*dd2:.2e}; max price err ~ n(0)*1tick/(sig sqrtT) = {2*dP:.2e}")
