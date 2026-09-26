"""T1 numeric check: closed-form Greeks of the settlement-matched binary P = Phi(d) against 50-digit finite
differences, their limits, and the on-chain delta (pdf / sqrtV from the integer spec) against the closed form.

Model (docs/md/SPEC.md §3.3, r = 0), with tD(tau), tV(tau) the effective drift and variance times of the window:
    d = (x - s^2 tD / 2) / (s sqrt(tV)),   P = Phi(d)
    dP/dx       = phi(d) / (s sqrt(tV))                        (delta in log-spot; dP/dS = that / S)
    d2P/dx2     = -d phi(d) / (s^2 tV)
    dP/ds       = phi(d) (-x / (s^2 sqrt(tV)) - tD / (2 sqrt(tV)))
    dP/dtau     = phi(d) (-s / (2 sqrt(tV)) - d / (2 tV))       (dtD/dtau = dtV/dtau = 1)

Run:  uv run --with mpmath python sim/greeks.py     (exit 1 on any failure)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import evm  # noqa: E402
from mpmath import diff, mp, mpf, ncdf, npdf, sqrt  # noqa: E402

mp.dps = 50
YEAR = 31_557_600
TOL_REL = mpf("1e-19")
FAILED = []


def times(tau, w, n):
    """(tD, tV) for real tau, as R.asian_times"""
    base, w = mpf(tau) - w, mpf(w)
    if n == 0:
        return base + w / 2, base + w / 3
    return base + w * (n - 1) / (2 * n), base + w * (n - 1) * (2 * n - 1) / (6 * n * n)


def d_of(x, s, tau, w, n):
    td, tv = times(tau, w, n)
    return (x - s * s * td / 2) / (s * sqrt(tv))


def P(x, s, tau, w, n):
    return ncdf(d_of(x, s, tau, w, n))


def greeks(x, s, tau, w, n):
    td, tv = times(tau, w, n)
    d = d_of(x, s, tau, w, n)
    f = npdf(d)
    return {
        "delta": f / (s * sqrt(tv)),
        "gamma": -d * f / (s * s * tv),
        "vega": f * (-x / (s * s * sqrt(tv)) - td / (2 * sqrt(tv))),
        "theta": f * (-s / (2 * sqrt(tv)) - d / (2 * tv)),
    }


def fd(x, s, tau, w, n):
    return {
        "delta": diff(lambda u: P(u, s, tau, w, n), x),
        "gamma": diff(lambda u: P(u, s, tau, w, n), x, 2),
        "vega": diff(lambda u: P(x, u, tau, w, n), s),
        "theta": diff(lambda u: P(x, s, u, w, n), tau),
    }


def check(name, ok, detail=""):
    if not ok:
        FAILED.append(name)
    print(f"  {'ok  ' if ok else 'FAIL'} {name} {detail}")


def main():
    print("== closed form vs 50-digit finite differences (relative, limit 1e-19)")
    worst = {k: mpf(0) for k in ("delta", "gamma", "vega", "theta")}
    cases = 0
    for sig in (mpf("0.2"), mpf("0.6"), mpf("1.5")):
        s = sig / sqrt(YEAR)
        for tau, w, n in ((3600, 0, 0), (86_400, 14_400, 0), (86_400, 14_400, 1440), (2_100, 1_800, 1), (700, 600, 600)):
            td, tv = times(tau, w, n)
            for dt in (-3, -1, -0.2, 0, 0.4, 1.5, 3):
                x = mpf(dt) * s * sqrt(tv) + s * s * td / 2
                g, h = greeks(x, s, tau, w, n), fd(x, s, tau, w, n)
                for k in worst:
                    if g[k] != 0:
                        worst[k] = max(worst[k], abs(g[k] - h[k]) / abs(g[k]))
                cases += 1
    for k, v in worst.items():
        check(f"{k:5s} over {cases} cases", v <= TOL_REL, f"max rel err {mp.nstr(v, 3)}")

    print("== limits")
    s = mpf("0.6") / sqrt(YEAR)
    far = greeks(mpf(3), s, 3600, 600, 0)
    check("|x| -> inf: delta, gamma, vega, theta -> 0", all(abs(v) < mpf("1e-100") for v in far.values()))
    tau0 = 600 + mpf("1e-30")
    xf = s * s * times(tau0, 600, 1)[0] / 2
    check("tau -> window, n = 1: at-the-forward delta -> inf", greeks(xf, s, tau0, 600, 1)["delta"] > 1e10)
    check("n = 0, tau -> window: tV -> w/3 > 0 keeps delta finite",
          greeks(mpf(0), s, 600 + mpf("1e-30"), 600, 0)["delta"] < 1e3)
    x0 = s * s * times(3600, 600, 0)[0] / 2
    check("at the forward (d = 0): gamma = 0", abs(greeks(x0, s, 3600, 600, 0)["gamma"]) < mpf("1e-40"))
    check("NO = 1 - YES: Greeks of NO are the negatives", abs(diff(lambda u: 1 - P(u, s, 3600, 600, 0), x0)
                                                            + greeks(x0, s, 3600, 600, 0)["delta"]) < mpf("1e-40"))

    print("== on-chain delta pdf/sqrtV (integer spec) vs closed form, on test-vector-like inputs")
    worst_rel = mpf(0)
    for sig in (0.2, 0.6, 1.5):
        v36 = int(mpf(sig) ** 2 * 10**36 / YEAR)
        s = sqrt(mpf(v36) / 10**36)
        for tau, w, n in ((3600, 0, 0), (86_400, 14_400, 1440), (700, 600, 600)):
            td, tv = times(tau, w, n)
            for dt in (-2, -0.5, 0, 1):
                x = int((mpf(dt) * s * sqrt(tv) + s * s * td / 2) * 10**18)
                d, sv, mid, pdf = evm.price(x, v36, tau, w, n)
                chain = mpf(pdf) / sv
                exact = greeks(mpf(x) / 10**18, s, tau, w, n)["delta"]
                worst_rel = max(worst_rel, abs(chain - exact) / exact)
    check("on-chain delta relative error <= 1e-12", worst_rel <= mpf("1e-12"), f"max {mp.nstr(worst_rel, 3)}")

    print()
    if FAILED:
        print("FAILED:", FAILED)
        sys.exit(1)
    print("greeks: all checks passed")


if __name__ == "__main__":
    main()
