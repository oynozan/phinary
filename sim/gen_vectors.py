"""Generate the committed test vectors in test/vectors/*.json (read by test/math/* via vm.readFile; no FFI).

Every value is a decimal string (JSON-safe for any consumer). Two kinds of expected values per vector:
  *RefE36 / *Ref : mpmath (50 digits) model value at the exact integer inputs, scaled by 1e36 (nearest)
  *Bits          : the integer spec in sim/evm.py, which the Solidity must reproduce bit for bit

Run:  uv run --with mpmath --with numpy python sim/gen_vectors.py
"""
import json
import os
import random
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import evm  # noqa: E402
import refmath as R  # noqa: E402
from mpmath import mpf, pi, sqrt  # noqa: E402

WAD = 10**18
E36 = 10**36
YEAR = 31_557_600
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test", "vectors")

# The 54 EVM-confirmed 1-wei up-ticks of the plain-WAD Hart port (research gaps/formal-verification-scripts HartCex).
WAD_PORT_CEX = [
    6202233335529410195, 6303079096165091875, 6027786722934775865, 5286460121124371423, 6661458662939610403,
    6440060383440821730, 6187948572333097328, 6872358835780745878, 6708725881521969668, 5699734168296885338,
    6861540423837912252, 6261417537473808714, 6586946719950138967, 7033987578397241766, 6287807734453241216,
    6866251872966935580, 6269369559929890963, 7018639873943999809, 6521026490074892365, 5522234626869426889,
    6961247426627469447, 6472486661021418114, 5346810820153643763, 6122979636497310445, 5816209346199876760,
    5737320250332275286, 5542473309140766945, 6428588690145350153, 6873274956246548227, 6402247417246185363,
    5436802834143626541, 5739864034497744388, 6170555127200533908, 5517256551338532797, 6304276255718248057,
    6836054508481123237, 6801063959607372407, 6786239988578995128, 6801882007148922120, 7014738756134657494,
    5284307399387502956, 5859223291689422138, 5828138772452585824, 5050085068442036099, 6204407000511264393,
    6741120820358182155, 5377058072789453700, 5807661220352765048, 5905284558499070212, 5946034498939224035,
    5261241198012984400, 6561247593932007152, 6712243007923218722, 6103744821760623262,
]
EXP_CUTOFF_Z = 9104562776310878106  # smallest z with expWad(-(z^2/W/2)) == 0 (checked below)


def s(v):
    return str(int(v))


def dump(name, obj):
    path = os.path.join(OUT, name)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
        f.write("\n")
    n = len(next(iter(obj.values())))
    print(f"  {name}: {n} vectors, {os.path.getsize(path) / 1e6:.2f} MB")


def var_e36(sigma):
    return int(mpf(sigma) ** 2 * E36 / YEAR)


# ------------------------------------------------------------------------------------------------ NormalCdf
def normal_inputs(rng):
    xs = set()
    xs.update(i * 10**16 for i in range(-4000, 4001))  # [-40, 40] step 0.01
    xs.update(i * 2 * 10**13 for i in range(-5000, 5001))  # [-0.1, 0.1] step 2e-5
    xs.update(rng.randint(-10 * WAD, 10 * WAD) for _ in range(3000))  # wei-level on [-10, 10]
    for _ in range(600):  # tails, both branches of the rational/continued fraction
        z = rng.randint(5 * WAD, 40 * WAD)
        xs.update((z, -z))
    for z in WAD_PORT_CEX:
        xs.update((z, z + 1, -z, -z - 1))
    seams = [0, 1, 2, 3, 10**3, 10**9, 1_414_213_562, 1_414_213_563, 10**15, evm.SPLIT, evm.SATURATE, EXP_CUTOFF_Z]
    for c in seams:
        for k in (-2, -1, 0, 1, 2):
            xs.update((c + k, -(c + k)))
    xs.update(-(10**k) for k in range(19))
    xs.update(10**k for k in range(19))
    return sorted(xs)


def gen_normal(rng):
    assert evm.e_of(EXP_CUTOFF_Z) == 0 and evm.e_of(EXP_CUTOFF_Z - 1) > 0
    xs = normal_inputs(rng)
    out = {"x": [], "cdfRefE36": [], "pdfRefE36": [], "cdfBits": [], "pdfBits": []}
    worst = (0, 0)
    for x in xs:
        xr = mpf(x) / WAD
        ref = R.to_scale(R.Phi(xr))
        c = evm.cdf(x)
        err = abs(c * WAD - ref)
        if err > worst[0]:
            worst = (err, x)
        out["x"].append(s(x))
        out["cdfRefE36"].append(s(ref))
        out["pdfRefE36"].append(s(R.to_scale(R.phi(xr))))
        out["cdfBits"].append(s(c))
        out["pdfBits"].append(s(evm.pdf(x)))
    print(f"  NormalCdf: max |cdf - Phi| = {worst[0] / E36:.3e} at x = {worst[1] / WAD}")
    dump("normal_cdf.json", out)


def gen_band(rng):
    kappas = [0, 1, 10**9, 10**20, 4 * 10**24, 2 * 10**25, 10**26, 3 * 10**26, 5 * 10**26, 10**27, 3 * 10**27,
              10**30, evm.KAPPA_MAX, evm.KAPPA_MAX + 1]
    xs = [0, 1, -1, 2, -2, evm.SPLIT - 1, evm.SPLIT, evm.SPLIT + 1, -evm.SPLIT, -evm.SPLIT + 1, EXP_CUTOFF_Z,
          -EXP_CUTOFF_Z, evm.SATURATE, evm.SATURATE + 1, -evm.SATURATE - 1]
    xs += [rng.randint(-10 * WAD, 10 * WAD) for _ in range(150)]
    out = {"x": [], "kappaE27": [], "upBits": [], "dnBits": [], "upRefE36": [], "dnRefE36": []}
    sq = sqrt(2 * pi)
    for x in xs:
        for kap in kappas + [rng.randint(0, 10**28)]:
            up, dn = evm.band(x, kap)
            xr = mpf(x) / WAD
            k = mpf(kap) / 10**27 * sq
            out["x"].append(s(x))
            out["kappaE27"].append(s(kap))
            out["upBits"].append(s(up))
            out["dnBits"].append(s(dn))
            out["upRefE36"].append(s(min(R.to_scale(R.Phi(xr) + k * R.phi(xr)), E36)))
            out["dnRefE36"].append(s(max(R.to_scale(R.Phi(xr) - k * R.phi(xr)), 0)))
    dump("normal_band.json", out)


# ------------------------------------------------------------------------------------------------ BinaryPricer
def pricer_cases(rng):
    sigmas = [0.20, 0.35, 0.60, 1.00, 1.50, 2.50]
    configs = []  # (tau, window, n)
    for n in (0, 10):
        for tau in (11, 12, 13, 20, 30, 45, 60):
            configs.append((tau, 10, n))
    for n in (0, 900):
        for tau in (1800 + 300, 2400, 3600):
            configs.append((tau, 1800, n))
    for n in (0, 1, 2, 48, 14400):
        for tau in (14400 + 300, 14400 + 3600, 86400, 7 * 86400):
            configs.append((tau, 14400, n))
    for n in (0, 5):
        for tau in (1, 60, 3600, 86400, 30 * 86400):
            configs.append((tau, 0, n))
    d_targets = [-12, -8.5, -6, -4, -2.5, -1, -0.3, -0.01, 0, 0.01, 0.3, 1, 2.5, 4, 6, 8.5, 12]
    cases = []
    for sig in sigmas:
        v36 = var_e36(sig)
        for tau, w, n in configs:
            b0 = R.binary(0, v36, tau, w, n)
            half = mpf(v36) / E36 * R.frac(b0["tDrift"]) / 2
            for dt in d_targets:
                x = int((dt * b0["sqrtV"] + half) * WAD)
                cases.append((x, v36, tau, w, n))
    for _ in range(1500):
        v36 = rng.randint(var_e36(0.05), var_e36(5.0))
        w = rng.choice([0, 1, 10, 60, 600, 1800, 14400, rng.randint(0, 20000)])
        tau = w + rng.choice([1, 2, 5, 30, 300, 3600, 86400, rng.randint(1, 30 * 86400)])
        n = rng.choice([0, 1, 2, 3, 10, 60, 1000, rng.randint(0, 20000)])
        x = rng.randint(-3 * WAD, 3 * WAD)
        cases.append((x, v36, tau, w, n))
    return cases


def gen_pricer(rng):
    keys = ["x", "varE36", "tau", "window", "n", "gammaS", "h0", "tDriftE18", "tVarE18", "dRefE36", "midRefE36",
            "pdfRefE36", "askRefE36", "bidRefE36", "sqrtVBits", "dBits", "midBits", "pdfBits", "askBits", "bidBits",
            "mid5Bits", "pdf5Bits", "ask5Bits", "bid5Bits", "mid5RefE36", "ask5RefE36", "bid5RefE36"]
    out = {k: [] for k in keys}
    worst = 0
    for x, v36, tau, w, n in pricer_cases(rng):
        g = rng.choice([0, 5 * 10**14, 10**15, rng.randint(0, 2 * 10**16)])
        h0 = rng.choice([0, 2 * 10**16, rng.randint(0, 5 * 10**16)])
        td, tv = evm.effective_times(tau, w, n)
        ref = R.binary(x, v36, tau, w, n)
        assert td == (ref["tDrift"] * WAD).__floor__() and tv == (ref["tVar"] * WAD).__floor__()
        d, sv, mid, pdf = evm.price(x, v36, tau, w, n)
        ask, bid = evm.ask_bid(d, sv, mid, pdf, 0, g, h0)
        _, _, mid5, pdf5 = evm.price_kernel(x, v36, tau, w, n, 1)
        ask5, bid5 = evm.ask_bid(d, sv, mid5, pdf5, 1, g, h0)
        assert ask >= mid + h0 and ask5 >= mid5 + h0 and bid <= mid and bid5 <= mid5
        _, _, ask_spec, bid_spec = R.ask_bid(x, v36, tau, w, n, g, h0)
        _, _, ask5_spec, bid5_spec = R.ask_bid(x, v36, tau, w, n, g, h0, kernel=1)
        mid_ref = R.to_scale(ref["mid"])
        worst = max(worst, abs(mid * WAD - mid_ref))
        row = [x, v36, tau, w, n, g, h0, td, tv, R.to_scale(ref["d"]), mid_ref, R.to_scale(ref["pdf"]),
               ask_spec * WAD, bid_spec * WAD, sv, d, mid, pdf, ask, bid, mid5, pdf5, ask5, bid5,
               R.to_scale(R.t_vm_cdf(5, ref["d"])), ask5_spec * WAD, bid5_spec * WAD]
        for k, v in zip(keys, row):
            out[k].append(s(v))
    print(f"  BinaryPricer: max |mid - Phi(d)| = {worst / E36:.3e}")
    dump("binary_pricer.json", out)


# ------------------------------------------------------------------------------------------------ QuoteMath
FN_BUY_OUT, FN_BUY_IN, FN_SELL_IN, FN_SELL_OUT = 0, 1, 2, 3
ERR_NONE, ERR_BAND, ERR_UNREACHABLE = 0, 1, 2


def log_uniform(rng, lo, hi):
    return int(10 ** rng.uniform(lo, hi))


def quote_cases(rng):
    cases = [(FN_SELL_OUT, 10_020_000_000_000_000, 55_778, 0, 9 * 10**14)]  # research Lemma S sell counterexample
    cases += [(FN_BUY_IN, 41 * 10**16, 0, 0, 100 * 10**6)]  # 01 §1.8 worked example: 243,902,439 YES
    for _ in range(2500):
        fn = rng.randrange(4)
        p = rng.choice([rng.randint(10**16, 99 * 10**16), rng.randint(1, 10**18), 2 * 10**16, 98 * 10**16])
        lam = rng.choice([0, log_uniform(rng, 3, 17), 10**13])
        i0 = rng.choice([0, rng.randint(-10**13, 10**13), -log_uniform(rng, 0, 13), log_uniform(rng, 0, 13)])
        amt = rng.choice([0, 1, log_uniform(rng, 0, 15), rng.randint(1, 10**12)])
        cases.append((fn, p, lam, i0, amt))
    MA, ML, MP = evm.MAX_AMOUNT, evm.MAX_LAM, evm.MAX_PRICE
    I_MIN, I_MAX, U_MAX = -(1 << 255), (1 << 255) - 1, (1 << 256) - 1
    edges = [(5 * 10**17, 10**13, 0, MA), (5 * 10**17, 10**13, 0, MA + 1), (5 * 10**17, 10**13, 0, U_MAX),
             (5 * 10**17, ML, 0, 10**6), (5 * 10**17, ML + 1, 0, 10**6), (5 * 10**17, U_MAX, 0, 10**6),
             (MP, 0, 0, 10**6), (MP + 1, 0, 0, 10**6), (U_MAX, 0, 0, 10**6),
             (5 * 10**17, 10**13, MA, 10**6), (5 * 10**17, 10**13, -MA, 10**6), (5 * 10**17, 10**13, MA + 1, 10**6),
             (5 * 10**17, 10**13, -MA - 1, 10**6), (5 * 10**17, 10**13, I_MIN, 10**6), (5 * 10**17, 10**13, I_MAX, 10**6),
             (MP, ML, MA, MA), (MP, ML, 49 * 10**12, MA), (MP, ML, 49 * 10**12 + 1, MA), (5 * 10**17, 10**16, 10**13, MA)]
    for p, lam, i0, amt in edges:
        for fn in range(4):
            cases.append((fn, p, lam, i0, amt))
    return cases


def in_domain(p, lam, i0, amt):
    b = 2 * 10**6 * p + 2 * lam * i0
    return p <= evm.MAX_PRICE and lam <= evm.MAX_LAM and abs(i0) <= evm.MAX_AMOUNT and amt <= evm.MAX_AMOUNT \
        and 0 < b <= evm.MAX_BETA


def gen_quote(rng):
    out = {"fn": [], "price": [], "lam": [], "i0": [], "amt": [], "out": [], "err": []}
    counts = [0, 0, 0]
    for fn, p, lam, i0, amt in quote_cases(rng):
        f = [evm.buy_exact_out, evm.buy_exact_in, evm.sell_exact_in, evm.sell_exact_out][fn]
        try:
            res, err = f(p, lam, i0, amt), ERR_NONE
        except evm.Revert as e:
            res, err = 0, {"Band": ERR_BAND, "Unreachable": ERR_UNREACHABLE}[e.name]
        beta = 2 * 10**6 * p + 2 * lam * i0
        if in_domain(p, lam, i0, amt) and amt <= 10**15:
            if fn == FN_BUY_OUT:
                assert res == R.def_buy_exact_out(lam, p, i0, amt)
            elif fn == FN_BUY_IN:
                assert res == R.def_buy_exact_in(lam, p, i0, amt)
            elif fn == FN_SELL_IN:
                on_branch = 2 * lam * amt <= beta
                assert (err == ERR_NONE) == on_branch
                if on_branch:
                    assert res == R.def_sell_exact_in(lam, p, i0, amt)
            else:
                ref = R.def_sell_exact_out(lam, p, i0, amt)
                assert (err == ERR_NONE) == (ref is not None), (p, lam, i0, amt, err, ref)
                if ref is not None:
                    assert res == ref
        elif not in_domain(p, lam, i0, amt):
            assert err == ERR_BAND
        counts[err] += 1
        for k, v in zip(out, (fn, p, lam, i0, amt, res, err)):
            out[k].append(s(v))
    print(f"  QuoteMath: ok/Band/Unreachable = {counts}; all agree with the search-based definitions")
    dump("quote_math.json", out)


# ------------------------------------------------------------------------------------------------ StudentTCdf
def gen_student(rng):
    ds = set(i * 5 * 10**15 for i in range(-2400, 2401))  # [-12, 12] step 5e-3
    ds.update(rng.randint(-50 * WAD, 50 * WAD) for _ in range(1500))
    for k in range(200):
        v = int(mpf(10) ** (1 + 5.3 * k / 199) * WAD)
        ds.update((v, -v))
    ds.update(rng.randint(-10**15, 10**15) for _ in range(300))
    for c in (0, 1, 7, evm.DSAT5, 10**24):
        for k in (-1, 0, 1):
            ds.update((c + k, -(c + k)))
    out = {"d": [], "cdfRefE36": [], "pdfRefE36": [], "cdfBits": [], "pdfBits": []}
    worst = 0
    for d in sorted(ds):
        dr = mpf(d) / WAD
        ref = R.to_scale(R.t_vm_cdf(5, dr))
        c = evm.cdf5(d)
        worst = max(worst, abs(c * WAD - ref))
        out["d"].append(s(d))
        out["cdfRefE36"].append(s(ref))
        out["pdfRefE36"].append(s(R.to_scale(R.t_vm_pdf(5, dr))))
        out["cdfBits"].append(s(c))
        out["pdfBits"].append(s(evm.pdf5(d)))
    print(f"  StudentTCdf: max |cdf5 - F_vm| = {worst / E36:.3e}")
    dump("student_t5.json", out)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    t0 = time.time()
    gen_normal(random.Random(1))
    gen_band(random.Random(2))
    gen_pricer(random.Random(3))
    gen_quote(random.Random(4))
    gen_student(random.Random(5))
    print(f"done in {time.time() - t0:.1f}s")
