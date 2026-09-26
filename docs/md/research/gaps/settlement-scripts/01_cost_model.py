"""(a) Cost of shifting a w-window geometric mean (oracle = end-of-block pool price) by delta,
band-follower pool with fee band +-f, attacker at the bottom of each block. Compares simulation to
closed forms: reflected-BM (continuous, delta<f), exact discrete pin/offset formula (delta>=f),
report 05 s4.7c (band-aware, no maintenance term) and report 02 s5.4 (band-free)."""
import numpy as np
from math import sqrt
from common import *

rng = np.random.default_rng(7)


def pin_offset_cost_per_block(sb, f, e, n=2_000_000):
    """exact per-block expected cost (units y_v) of keeping the end-of-block price at X+f+e (e>=0), band follower,
    via the closed-form integral ((2f+e)^2 - (clip(f+e-dX,-f,f)+f)^2)/4 averaged over dX ~ N(0,sb^2)."""
    dX = rng.normal(0, sb, n)
    u0 = np.clip(f + e - dX, -f, f)
    return np.mean(((2 * f + e) ** 2 - (u0 + f) ** 2) / 4)


def reflected_bm_cost(sig, w_s, f, d):
    """continuous-time in-band cost of raising the lower band edge by s = 2d for a window w (units y_v)."""
    return sig**2 * (w_s / YEAR) * d / (4 * (f - d)) if d < f else float('inf')


if __name__ == "__main__":
    yv = 155.5e6  # live v3 USDC/WETH 5 bp virtual USDC reserve (2026-09-25)
    for sig, dt, f, w_min, lab in [(0.52, 12, 0.0005, 30, "L1 12s, f=5bp, w=30m"),
                                   (0.52, 12, 0.0001, 30, "L1 12s, f=1bp, w=30m"),
                                   (0.52, 12, 0.0030, 30, "L1 12s, f=30bp, w=30m"),
                                   (0.52, 2, 0.0005, 30, "L2 2s, f=5bp, w=30m"),
                                   (0.52, 12, 0.0005, 120, "L1 12s, f=5bp, w=2h")]:
        n_w = int(w_min * 60 / dt); sb = sig * sqrt(dt / YEAR)
        print(f"\n=== {lab}: sigma={sig}, sigma_block={sb*1e4:.2f}bp, n_w={n_w}, y_v=${yv/1e6:.1f}M ===")
        fr = [0, 0.25, 0.5, 1.0, 1.5, 1.8, 2.0, 2.4, 3.0, 4.0, 6.0, 10.0]
        s_list = [x * f for x in fr]
        res = simulate_floor_attack(sig, dt, f, n_w, s_list, npaths=4000 if dt > 2 else 1500, seed=11)
        print(f"{'s/f':>5} {'shift bp':>9} {'sim cost $':>11} {'(sd $)':>9} | {'reflBM $':>9} {'exact pin/offset $':>18} | {'05 s4.7c $':>10} {'02 s5.4 $':>10}")
        for x, s in zip(fr, s_list):
            d, c, csd, dsd = res[s]
            refl = reflected_bm_cost(sig, w_min * 60, f, d) * yv
            e = max(s - 2 * f, 0.0)
            exact = n_w * pin_offset_cost_per_block(sb, f, e) * yv if s >= 2 * f else float('nan')
            c05 = yv * (f * d + n_w * max(d - f, 0) * (d + 3 * f) / 4)
            c02 = n_w * yv * (d * d / 4 + f * d / 2)
            print(f"{x:5.2f} {d*1e4:9.2f} {c*yv:11,.0f} {csd*yv:9,.0f} | {refl:9,.0f} {exact:18,.0f} | {c05:10,.0f} {c02:10,.0f}")
