"""T2 Monte Carlo: the closed-form price (BinaryPricer via the bit-exact integer spec sim/evm.py) against the
settlement rule applied to GBM paths sampled the way the oracle samples them.

Oracle and settlement (docs/md/SPEC.md §2, §3.5): blocks every `dt` seconds, the normalised tick floor(ln S / ln 1.0001)
written at each block prevails until the next, so D = cumulativeAt(T) - cumulativeAt(T - w) = dt * sum_k tick(t_k)
over the left endpoints t_k = T - w + k dt, k = 0..n-1 (n = w / dt). YES iff D * 1e18 > w * (strikeTickWad - 0.5e18).
Under r = 0 GBM, ln S(t) = ln S0 - s^2 t / 2 + s W(t). The closed form is priced with nSamples = n.

Checks (fixed seeds): every scenario agrees within 3 standard errors (and the share within 1 SE is reported); negative
controls that drop the half-tick or use the European N(d2) must disagree.

Run:  uv run --with mpmath --with numpy python sim/mc_settlement.py [paths]     (exit 1 on any failure)
"""
import math
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import evm  # noqa: E402

WAD = 10**18
YEAR = 31_557_600
LN_TICK = math.log(1.0001)
CHUNK = 20_000


def simulate(rng, paths, x0, var_s, tau, w, dt, strike_tick):
    """Fraction of paths settling YES under the oracle rule, with and without the half-tick, and its standard error."""
    n = w // dt
    s = math.sqrt(var_s)
    t0 = tau - w
    yes_half = yes_plain = 0
    done = 0
    while done < paths:
        m = min(CHUNK, paths - done)
        x_start = x0 - var_s * t0 / 2 + s * math.sqrt(t0) * rng.standard_normal(m)
        steps = -var_s * dt / 2 + s * math.sqrt(dt) * rng.standard_normal((m, n - 1))
        xs = np.concatenate([x_start[:, None], x_start[:, None] + np.cumsum(steps, axis=1)], axis=1)
        ticks = np.floor(strike_tick + xs / LN_TICK)
        cum = dt * ticks.sum(axis=1)
        yes_half += int(np.count_nonzero(cum > w * (strike_tick - 0.5)))
        yes_plain += int(np.count_nonzero(cum > w * strike_tick))
        done += m
    return yes_half / paths, yes_plain / paths


def main():
    paths = int(sys.argv[1]) if len(sys.argv) > 1 else 400_000
    rng = np.random.default_rng(20260926)
    scenarios = []  # (label, sigma, tau, w, dt, dTarget)
    for sig, tau, w in ((0.6, 900, 600), (1.0, 2_100, 1_800), (0.35, 4_200, 3_600)):
        for dtg in (-1.2, 0.0, 0.7):
            scenarios.append((f"sigma {sig:.2f} tau {tau} w {w}", sig, tau, w, 1, dtg))
    scenarios.append(("sigma 0.60 tau 1260 w 1200 dt 2", 0.6, 1_260, 1_200, 2, 0.3))
    failed = []
    within1 = 0
    pooled = pooled_plain = pooled_euro = 0.0
    strike_tick = 80_000.37
    print(f"{'scenario':34s} {'d':>5s} {'closed form':>12s} {'MC (half-tick)':>15s} {'z':>6s} "
          f"{'no half-tick z':>15s} {'European z':>11s}")
    for label, sig, tau, w, dt, dtg in scenarios:
        v36 = int(sig * sig * 10**36 / YEAR)
        var_s = v36 / 10**36
        n = w // dt
        _, sv, _, _ = evm.price(0, v36, tau, w, n)
        t_drift, _ = evm.effective_times(tau, w, n)
        x = int((dtg * sv / WAD + var_s * t_drift / WAD / 2) * WAD)
        d, _, mid, _ = evm.price(x, v36, tau, w, n)
        p = mid / WAD
        p_euro = evm.price(x, v36, tau, 0, 0)[2] / WAD
        mc, mc_plain = simulate(rng, paths, x / WAD, var_s, tau, w, dt, strike_tick)
        se = math.sqrt(max(p * (1 - p), 1e-12) / paths)
        z = (mc - p) / se
        z_plain = (mc_plain - p) / se
        z_euro = (mc - p_euro) / se
        within1 += abs(z) <= 1
        pooled += z / math.sqrt(len(scenarios))
        pooled_plain += z_plain / math.sqrt(len(scenarios))
        pooled_euro += abs(z_euro) / math.sqrt(len(scenarios))
        ok = abs(z) <= 3
        if not ok:
            failed.append(label)
        print(f"{label:34s} {d / WAD:5.2f} {p:12.6f} {mc:15.6f} {z:6.2f} {z_plain:15.2f} {z_euro:11.2f}"
              f"{'' if ok else '   FAIL'}")
    k = len(scenarios)
    print(f"\n{paths} paths per scenario; |z| <= 1 in {within1}/{k} scenarios (about 68% expected), all within 3 SE: "
          f"{not failed}; pooled z {pooled:.2f} (|.| <= 3 required)")
    if abs(pooled) > 3:
        failed.append("pooled bias")
    print(f"negative controls, pooled z: no half-tick {pooled_plain:.1f} (must be < -3), "
          f"European N(d2) {pooled_euro:.1f} (must be > 3)")
    if pooled_plain >= -3:
        failed.append("control: dropping the half-tick is not detected")
    if pooled_euro <= 3:
        failed.append("control: the European price is not rejected")
    if failed:
        print("FAILED:", failed)
        sys.exit(1)
    print("mc_settlement: closed form matches the oracle's settlement statistic")


if __name__ == "__main__":
    main()
