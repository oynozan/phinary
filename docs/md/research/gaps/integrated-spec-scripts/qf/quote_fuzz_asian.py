"""
Property fuzzing of the integer reference quote function (quote_ref.py).
Run:  uv run --with mpmath python quote_fuzz.py [N]
Every property prints (#checked, #violations).  Counterexample sections print the broken
variants that the spec rules out.
"""
import sys, random, math, copy
from quote_ref_asian import *
import os
MODE = os.environ.get('MODE', 'asian')

N = int(sys.argv[1]) if len(sys.argv) > 1 else 3000
rng = random.Random(20260925)
NOW = 1_800_000_000


def rand_amount_units(lo=1, hi=10**11):
    # log-uniform between 1 unit and 100k tokens
    return int(math.exp(rng.uniform(math.log(lo), math.log(hi))))


def rand_Lam():
    r = rng.random()
    if r < 0.1:
        return 0
    if r < 0.2:
        return rng.choice([1, 2, 3])
    return int(math.exp(rng.uniform(math.log(10**9), math.log(10**16))))


def rand_params(**kw):
    wS = rng.choice([1800, 7200, 14400]); dts = rng.choice([2, 12])
    tau = wS + 300 + int(math.exp(rng.uniform(math.log(60), math.log(30 * 86400))))
    sig = rng.uniform(0.2, 1.5)
    P = default_params(now=NOW, tau=tau, sigma2=int(sig * sig * WAD),
                       Lam=rand_Lam(), W_a=rng.choice([0, 0, 24, 60]),
                       h0=rng.choice([0, 10**15, 3 * 10**15, 10**16]),
                       c_delta=rng.choice([0, WAD // 2, WAD, 2 * WAD]),
                       Qcap=rng.choice([10**9, 10**11, 10**13]),
                       c_inv=rng.choice([0, 10**16]),
                       dt_epoch=rng.choice([1, 2, 12]), mode=MODE, w_settle=wS, dt_samp=dts, tau_min=wS + 300,
                       ramp_h=int(rng.choice([0.0025, 0.005, 0.01]) * WAD) if MODE == 'ramp' else 0)
    for k, v in kw.items():
        setattr(P, k, v)
    return P


def rand_x(P, spread=2.5):
    """log spot around the strike, within +-spread * sigma*sqrt(tau)."""
    tau = P.expiry - NOW
    ssd = math.sqrt(P.sigma2 / WAD * tau / YEAR)
    return P.lnK + int(rng.uniform(-spread, spread) * ssd * WAD)


def twap_of(P, x):
    tau = P.expiry - NOW
    ssd = math.sqrt(P.sigma2 / WAD * tau / YEAR)
    return x + int(rng.gauss(0, 0.3) * ssd * WAD)


def rand_market():
    P = rand_params()
    m = Market(P)
    m.roll(NOW)
    m.I = rng.randint(-P.Qcap // 4, P.Qcap // 4) if rng.random() < 0.7 else 0
    m.E = m.I + rng.randint(-P.cap_inv, P.cap_inv)
    return m


def tryrun(f, *a):
    try:
        return f(*a)
    except Halt:
        return None


results = {}


def rec(name, ok):
    c, v = results.get(name, (0, 0))
    results[name] = (c + 1, v + (0 if ok else 1))


# ---------------------------------------------------------------- F1/F2 solver exactness
nofix_short = 0
nofix_total = 0
for _ in range(N * 10):
    Lam = rand_Lam()
    a = rng.randint(10**16, WAD - 10**16)
    I0 = rng.randint(-10**10, 10**10)
    if 2 * UNIT * a + 2 * Lam * I0 <= 0:
        continue
    A = rand_amount_units()
    q = buy_exact_in(Lam, a, I0, A)
    rec("F1 buy exact-in: cost(q)<=A", buy_exact_out(Lam, a, I0, q) <= A)
    rec("F1 buy exact-in: cost(q+1)>A (maximal)", buy_exact_out(Lam, a, I0, q + 1) > A)
    q0 = buy_exact_in(Lam, a, I0, A, fixup=False)
    nofix_total += 1
    nofix_short += (q0 < q)
    rec("F1 floor-isqrt candidate never over-delivers", q0 <= q)
    rec("F1 floor-isqrt candidate short by <=1 when Lam>=1", Lam == 0 or q - q0 <= 1)
    b = a
    # sell exact-out
    beta = 2 * UNIT * b + 2 * Lam * I0
    A2 = rand_amount_units(1, 10**10)
    qs = tryrun(sell_exact_out, Lam, b, I0, A2)
    if qs is not None:
        # restrict to increasing branch: marginal at end must be > 0
        if UNIT * b + Lam * (I0 - qs) > 0:
            rec("F2 sell exact-out: proceeds(q)>=A", sell_exact_in(Lam, b, I0, qs) >= A2)
            rec("F2 sell exact-out: proceeds(q-1)<A (minimal)", qs == 0 or sell_exact_in(Lam, b, I0, qs - 1) < A2)
print(f"floor-isqrt without fix-up under-delivers in {nofix_short}/{nofix_total} exact-in cases")

# ---------------------------------------------------------------- F3 naive WAD solver vs exact-integer solver
over = under = tot = 0
ex_over = ex_split = None
for _ in range(N * 20):
    Lam = rng.choice([10**6 + 1, 3 * 10**6 + 7, 10**9 + 3, 10**12 + 7, 3 * 10**13 + 11, 10**15 + 1])
    a = rng.randint(10**17, 9 * 10**17)
    I0 = rng.randint(-10**8, 10**8)
    if 2 * UNIT * a + 2 * Lam * I0 <= 0 or a + (Lam // UNIT) * I0 <= 0:
        continue
    A = rand_amount_units(1, 10**10)
    qe = buy_exact_in(Lam, a, I0, A)
    qn = buy_exact_in_naive_wad(Lam, a, I0, A)
    tot += 1
    if qn > qe:
        over += 1
        if ex_over is None:
            ex_over = (Lam, a, I0, A, qe, qn, buy_exact_out(Lam, a, I0, qn))
    elif qn < qe:
        under += 1
    if ex_split is None and A > 2:
        A1 = rng.randint(1, A - 1); A2 = A - A1
        q1 = buy_exact_in_naive_wad(Lam, a, I0, A1)
        q2 = buy_exact_in_naive_wad(Lam, a, I0 + q1, A2)
        if q1 + q2 > qn:
            ex_split = (Lam, a, I0, A1, A2, q1, q2, qn)
print(f"F3 naive WAD solver: over-delivers (cost(q)>A, vault loss) in {over}/{tot}, under-delivers in {under}/{tot}")
print("F3 over-delivery example (Lam,a,I0,A,q_exact,q_naive,true cost of q_naive):", ex_over)
print("F3 naive split-advantage example (Lam,a,I0,A1,A2,q1,q2,q_whole):", ex_split)

# ---------------------------------------------------------------- F4 no split advantage (full Market, YES and NO)
ops_in = ["buy_yes_in", "sell_yes_in", "buy_no_in", "sell_no_in", "buy_yes_out", "sell_yes_out", "buy_no_out", "sell_no_out"]
for _ in range(N):
    m = rand_market()
    P = m.P
    x = rand_x(P); xt = twap_of(P, x)
    op = rng.choice(ops_in)
    amt = rand_amount_units(2, 10**10)
    a1 = rng.randint(1, amt - 1)
    a2 = amt - a1
    whole = copy.deepcopy(m); s1 = copy.deepcopy(m)
    r_all = tryrun(getattr(whole, op), x, xt, NOW, amt)
    r1 = tryrun(getattr(s1, op), x, xt, NOW, a1)
    r2 = tryrun(getattr(s1, op), x, xt, NOW, a2) if r1 else None
    if r1 is None or r2 is None:
        continue
    if r_all is None:
        rec("F4 split: combined halts while parts succeed (allowed, not an arbitrage)", True)
        continue
    # r = (in, out) for the trader. Split must not give more out for the same in, nor cost less in for same out
    if op.endswith("_in"):   # exact input: inputs equal, compare outputs
        rec(f"F4 no-split {op}", r1[1] + r2[1] <= r_all[1])
    else:                    # exact output: outputs equal, compare inputs
        rec(f"F4 no-split {op}", r1[0] + r2[0] >= r_all[0])
    if op in ("buy_yes_out", "buy_no_out", "sell_yes_in", "sell_no_in"):   # same token quantity -> same end state
        rec("F4 same token quantity -> same final I (path independence of state)", whole.I == s1.I and whole.E == s1.E)

# ---------------------------------------------------------------- F5 round trips in one epoch lose money
for _ in range(N):
    m = rand_market(); P = m.P
    x = rand_x(P); xt = twap_of(P, x)
    q = rand_amount_units(1, 10**10)
    kind = rng.randint(0, 5)
    mm = copy.deepcopy(m)
    try:
        if kind == 0:     # buy YES exact-out q, sell YES exact-in q
            c, _ = mm.buy_yes_out(x, xt, NOW, q); _, p = mm.sell_yes_in(x, xt, NOW, q); net = p - c
        elif kind == 1:   # buy NO exact-out q, sell NO exact-in q
            c, _ = mm.buy_no_out(x, xt, NOW, q); _, p = mm.sell_no_in(x, xt, NOW, q); net = p - c
        elif kind == 2:   # sell YES first (trader holds YES), then buy back
            _, p = mm.sell_yes_in(x, xt, NOW, q); c, _ = mm.buy_yes_out(x, xt, NOW, q); net = p - c
        elif kind == 3:   # buy YES q + buy NO q via hook, merge -> q USDC
            c1, _ = mm.buy_yes_out(x, xt, NOW, q); c2, _ = mm.buy_no_out(x, xt, NOW, q); net = q - c1 - c2
        elif kind == 4:   # mint q (pay q), sell YES q and NO q to hook
            _, p1 = mm.sell_yes_in(x, xt, NOW, q); _, p2 = mm.sell_no_in(x, xt, NOW, q); net = p1 + p2 - q
        else:             # exact-in USDC -> YES -> USDC
            A = q
            _, got = mm.buy_yes_in(x, xt, NOW, A); _, p = mm.sell_yes_in(x, xt, NOW, got); net = p - A
    except Halt:
        continue
    rec(f"F5 round trip kind {kind}: trader net <= 0", net <= 0)
    if kind in (0, 1, 2):
        rec(f"F5 round trip kind {kind}: loses >= 2*h0*q (minus 1 unit rounding slack none)", net <= -(2 * P.h0 * q) // (WAD) + 0)

# ---------------------------------------------------------------- F6 no-arb sums at every impact state
for _ in range(N):
    m = rand_market(); P = m.P
    x = rand_x(P); xt = twap_of(P, x)
    try:
        Q = epoch_quote(P, x, xt, NOW, m.E - m.I)
    except Halt:
        continue
    # marginal WAD at state I (per-unit, scaled by UNIT)
    aI = UNIT * Q.a + P.Lam * m.I
    bI = UNIT * Q.b + P.Lam * m.I
    askN = UNIT * WAD - bI
    bidN = UNIT * WAD - aI
    rec("F6 marginal: bidY+bidN <= 1", bI + bidN <= UNIT * WAD)
    rec("F6 marginal: askY+askN >= 1", aI + askN >= UNIT * WAD)
    q = rand_amount_units(1, 10**10)
    # simultaneous from the same state
    cy = buy_exact_out(P.Lam, Q.a, m.I, q); cn = buy_exact_out(P.Lam, WAD - Q.b, -m.I, q)
    py = sell_exact_in(P.Lam, Q.b, m.I, q); pn = sell_exact_in(P.Lam, WAD - Q.a, -m.I, q)
    rec("F6 amounts: cost(YES q)+cost(NO q) >= q (same state)", cy + cn >= q)
    rec("F6 amounts: proceeds(YES q)+proceeds(NO q) <= q (same state)", py + pn <= q)

# ---------------------------------------------------------------- F7 monotonicity in both S inputs
def outcomes(m, x, xt, amt):
    out = {}
    for op in ["buy_yes_in", "buy_yes_out", "sell_yes_in", "buy_no_in", "sell_no_in", "sell_yes_out", "buy_no_out", "sell_no_out"]:
        r = tryrun(getattr(copy.deepcopy(m), op), x, xt, NOW, amt)
        out[op] = r
    return out


# direction each trader-received / trader-paid quantity must move when S rises
#   buy_yes_in : YES out   non-increasing     buy_yes_out: USDC in  non-decreasing
#   sell_yes_in: USDC out  non-decreasing     sell_yes_out: YES in non-increasing
#   buy_no_in  : NO out    non-decreasing     buy_no_out : USDC in  non-increasing
#   sell_no_in : USDC out  non-increasing     sell_no_out: NO in    non-decreasing
rules = {"buy_yes_in": (1, -1), "buy_yes_out": (0, +1), "sell_yes_in": (1, +1), "sell_yes_out": (0, -1),
         "buy_no_in": (1, +1), "buy_no_out": (0, -1), "sell_no_in": (1, -1), "sell_no_out": (0, +1)}


def mono_run(label, n, **override):
    viol_example = None
    for _ in range(n):
        m = rand_market()
        for k, v in override.items():
            setattr(m.P, k, v)
        if "W_a" not in override and rng.random() < 0.5:
            m.P.W_a = 60
        P = m.P
        x = rand_x(P, 3.0); xt = twap_of(P, x)
        tau = P.expiry - NOW
        ssd = math.sqrt(P.sigma2 / WAD * tau / YEAR)
        dx = int(abs(rng.gauss(0, 0.2)) * ssd * WAD) + 1
        which = rng.randint(0, 2)   # 0 bump sob, 1 bump twap, 2 bump both
        x2 = x + (dx if which in (0, 2) else 0)
        xt2 = xt + (dx if which in (1, 2) else 0)
        amt = rand_amount_units(1, 10**9)
        o1 = outcomes(m, x, xt, amt); o2 = outcomes(m, x2, xt2, amt)
        for op, (idx, sgn) in rules.items():
            if o1[op] is None or o2[op] is None:
                continue
            v1, v2 = o1[op][idx], o2[op][idx]
            ok = (v2 - v1) * sgn >= 0
            rec(f"{label} {op}", ok)
            if not ok and viol_example is None:
                viol_example = (op, which, v1, v2, float(epoch_quote(P, x, xt, NOW, m.E - m.I).k))
    return viol_example


mono_run("F7 monotone (spec)", N)
# broken variant A: gamma term outside the max/min
ex = mono_run("F7x gamma-outside-max (broken)", N, dual_gamma_inside=False, W_a=60, c_delta=4 * WAD, tau_min=0)
print("F7x counterexample gamma outside max:", ex)
# variant B: no k cap (k*z_band > 1 allowed) -- monotonicity must still hold because of the band halt
ex = mono_run("F7y no k cap at all (k up to ~10): still monotone by the Mills-ratio lemma", N, k_max=100 * WAD, c_delta=8 * WAD, tau_min=0)
print("F7y counterexample with k uncapped:", ex)
# Mills-ratio lemma: for every k>0 and d>1/k, Phi(d)+k*phi(d) > 1  (so the band halt covers the decreasing region)
worst = 0.0
for k in [0.01, 0.05, 0.1, 0.3, 1, 3, 10]:
    for j in range(1, 400):
        d = 1 / mpf(k) + j * mpf(0.02) * max(1, 1 / k)
        ratio = ncdf(-d) / (k * npdf(d))      # lemma <=> ratio < 1  (1-Phi(d) < k*phi(d))
        worst = max(worst, float(ratio))
print("Mills lemma: max over grid of (1-Phi(d))/(k phi(d)) for d>1/k =", worst, "(<1 as required)")
# naive-solver split search, targeted
ex = None
for _ in range(200000):
    Lam = rng.choice([3 * 10**13 + 11, 10**12 + 7, 10**15 + 1, 7 * 10**14 + 3])
    a = rng.randint(10**17, 9 * 10**17)
    A = rng.randint(3, 10**6)
    A1 = rng.randint(1, A - 1); A2 = A - A1
    qw = buy_exact_in_naive_wad(Lam, a, 0, A)
    q1 = buy_exact_in_naive_wad(Lam, a, 0, A1)
    q2 = buy_exact_in_naive_wad(Lam, a, q1, A2)
    if q1 + q2 > qw:
        ex = (Lam, a, A1, A2, q1, q2, qw, buy_exact_in(Lam, a, 0, A))
        break
print("F3b naive WAD solver split advantage (Lam,a,A1,A2,q1,q2,q_whole_naive,q_whole_exact):", ex)

# ---------------------------------------------------------------- F8 separate YES/NO impact states break no-arb
P = default_params(now=NOW, tau=86400, Lam=10**13, h0=3 * 10**15, c_delta=0, W_a=0)
x = P.lnK
Q = epoch_quote(P, x, x, NOW, 0)
IY = 2_000 * UNIT          # other traders bought 2k YES this epoch -> YES impact +0.02
IN = 0
# with separate states the YES bid is b + Lam*IY, the NO bid is (1 - a) + Lam*IN
q = 100 * UNIT
proceeds_yes = sell_exact_in(P.Lam, Q.b, IY, q)
proceeds_no_separate = sell_exact_in(P.Lam, WAD - Q.a, IN, q)
proceeds_no_shared = sell_exact_in(P.Lam, WAD - Q.a, -IY, q)
print(f"F8 separate impact: mint {q/UNIT:.0f} sets for {q/UNIT:.0f} USDC, sell both -> {(proceeds_yes+proceeds_no_separate)/UNIT:.4f} USDC "
      f"(profit {(proceeds_yes+proceeds_no_separate-q)/UNIT:+.4f});  shared signed impact -> {(proceeds_yes+proceeds_no_shared)/UNIT:.4f} "
      f"(profit {(proceeds_yes+proceeds_no_shared-q)/UNIT:+.4f})")

# ---------------------------------------------------------------- F9 clamp-mid instead of halt
Pc = default_params(now=NOW, tau=3 * 86400, halt_outside_band=False, W_a=0, c_delta=0)
xdeep = Pc.lnK + int(0.25 * WAD)   # ETH 28% above strike, 3 days: fair ~0.99
fair = float(ncdf((mpf(xdeep - Pc.lnK) / WAD - mpf(0.36 * 3 / 365) / 2) / msqrt(0.36 * 3 / 365)))
Qc = epoch_quote(Pc, xdeep, xdeep, NOW, 0)
print(f"F9 clamp-mid: fair YES {fair:.5f}, clamped ask {Qc.a/WAD:.5f} -> buyer edge {fair - Qc.a/WAD:+.5f} per token every epoch "
      f"(spec halts instead: up_ok={epoch_quote(default_params(now=NOW, tau=3*86400, W_a=0, c_delta=0), xdeep, xdeep, NOW, 0).up_ok})")

print("\n=== property results (checked, violations) ===")
for k in sorted(results):
    print(f"{k:75s} {results[k][0]:7d} {results[k][1]:5d}")
