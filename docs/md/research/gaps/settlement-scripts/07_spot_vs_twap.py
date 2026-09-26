"""(c) Spot-at-T settlement (report 03 s5.5: one end-of-block price) vs a w-window TWAP: cost to shift the
settlement statistic by delta on the v3 5 bp pool (y_v $155.5M), band-follower sim, sigma 0.52, L1."""
from common import simulate_floor_attack
f, yv = 5e-4, 155.5e6
s_list = [0.5 * f, 1 * f, 2 * f, 3 * f, 4 * f, 8 * f, 12 * f]
for n_w, lab in [(1, "spot: one end-of-block sample"), (150, "TWAP w = 30 min")]:
    r = simulate_floor_attack(0.52, 12, f, n_w, s_list, npaths=20000 if n_w == 1 else 3000, seed=4)
    print(lab + ": " + "  ".join(f"{r[s][0]*1e4:.1f}bp:${r[s][1]*yv:,.0f}" for s in s_list))
print("(slot0 read at settle time instead of an end-of-block sample: round trip inside one unlock, fees only:"
      f" ~ 2 f y_v delta/2 = ${2*f*yv*0.003/2:,.0f} for 30 bp)")
