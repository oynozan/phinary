"""Monte Carlo coverage of the varianceE36 confidence band (PLAN C6).

Simulates GBM log-prices sampled once per block, floors them to normalised ticks (the oracle's tick path), and applies
the exact on-chain estimator: grid means over H seconds, winsorised squared differences, 3/2 factor, ln(1.0001)^2.
The band is the one OracleCalibration.t.sol uses: Wilson-Hilferty chi-square quantiles with nu = n / 1.125 (lag-one
correlation 1/4 of consecutive TWAP returns). Asserts the empirical coverage of the 95% band is within 3 binomial
standard errors of 95%.

Run: uv run --with numpy python test/oracle/sigma_coverage.py
"""

import math
import sys

import numpy as np

YEAR = 31_557_600
LN_TICK = math.log(1.0001)


def wh_ratio(nu, z):
    a = 2.0 / (9.0 * nu)
    return (1.0 - a + z * math.sqrt(a)) ** 3


def simulate(sigma, h, n, dt, winsor_ticks, paths, rng):
    per_window = h // dt
    blocks = (n + 1) * per_window
    sd = sigma * math.sqrt(dt / YEAR) / LN_TICK
    x = rng.uniform(0, 1, (paths, 1)) + np.cumsum(rng.standard_normal((paths, blocks)) * sd, axis=1)
    ticks = np.floor(x)
    d = ticks.reshape(paths, n + 1, per_window).sum(axis=2) * dt
    diff = np.clip(np.diff(d, axis=1), -winsor_ticks * h, winsor_ticks * h)
    var_per_sec = 3.0 * (diff**2).sum(axis=1) * LN_TICK**2 / (2.0 * h**3 * n)
    return var_per_sec * YEAR / sigma**2


def main():
    rng = np.random.default_rng(20260926)
    paths = 4000
    configs = [
        # sigma, H, nWindows, block time, winsorTicks
        (0.60, 120, 600, 12, 400),  # OracleCalibration.t.sol
        (0.60, 60, 240, 1, 400),  # demo on Unichain (1 s blocks)
        (0.60, 60, 30, 1, 400),  # minWindows-sized sample
        (0.30, 60, 1440, 2, 400),
    ]
    tol = 3 * math.sqrt(0.95 * 0.05 / paths)
    ok = True
    for sigma, h, n, dt, cap in configs:
        chunk = max(1, 20_000_000 // ((n + 1) * (h // dt)))
        ratio = np.concatenate(
            [simulate(sigma, h, n, dt, cap, min(chunk, paths - i), rng) for i in range(0, paths, chunk)]
        )
        nu = n / 1.125
        lo, hi = wh_ratio(nu, -1.959964), wh_ratio(nu, 1.959964)
        cov = float(np.mean((ratio >= lo) & (ratio <= hi)))
        good = abs(cov - 0.95) <= tol
        ok &= good
        print(
            f"sigma={sigma:.2f} H={h} n={n} dt={dt}: mean ratio {ratio.mean():.4f}, "
            f"sd {ratio.std():.4f} (band sd {math.sqrt(2 / nu):.4f}), 95% coverage {cov:.4f} "
            f"[{'ok' if good else 'FAIL'}]"
        )
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
