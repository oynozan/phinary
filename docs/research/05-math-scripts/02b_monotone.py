import math, random
import mpmath as mp
mp.mp.dps = 40
import importlib.util, sys
spec = importlib.util.spec_from_file_location("m2", "02_cdf_fixedpoint.py"); m2 = importlib.util.module_from_spec(spec); spec.loader.exec_module(m2)
WAD = m2.WAD; expWad = m2.expWad; solstat_cdf = m2.solstat_cdf

print("=== expWad accuracy for outputs > 1e12 wei, and monotonicity on random sorted pairs ===")
random.seed(2)
worst = 0
for _ in range(20000):
    x = random.randint(-27 * WAD, 60 * WAD)
    ex = mp.e**(mp.mpf(x) / WAD) * WAD
    worst = max(worst, abs(expWad(x) - ex) / ex)
print("expWad max rel err (x in [-27,60]) =", mp.nstr(worst, 4))
v = 0
for _ in range(100000):
    x = random.randint(-41 * WAD, 10 * WAD); y = x + random.randint(1, 10**random.randint(0, 18))
    if expWad(y) < expWad(x): v += 1
print("expWad decreases on 100k random x<y pairs:", v)

print("\n=== solstat cdf around 0 (the NR erfcc branch switch) ===")
for x in [-10**11, -10**10, -10**9, -10**8, -1, 0, 1, 10**8, 10**9, 10**10, 10**11]:
    print(f"x={x:>15} wei: cdf={solstat_cdf(x)}  exact={int(mp.ncdf(mp.mpf(x)/WAD)*WAD)}")
print("jump cdf(-1)-cdf(+1) =", solstat_cdf(-1) - solstat_cdf(1), "wei; the non-monotone band is |x| <~", 
      (solstat_cdf(-1)-solstat_cdf(1)) * math.sqrt(2*math.pi), "wei")

# ---- a WAD port of the Hart/West (Lyra) CDF with monotone assembly + clamp ----
N6,N5,N4,N3,N2,N1,N0 = [int(round(v*1e18)) for v in (0.0352624965998911,0.700383064443688,6.37396220353165,33.912866078383,112.079291497871,221.213596169931,220.206867912376)]
M7,M6,M5,M4,M3,M2,M1,M0 = [int(round(v*1e18)) for v in (0.0883883476483184,1.75566716318264,16.064177579207,86.7807322029461,296.564248779674,637.333633378831,793.826512519948,440.413735824752)]
SPLIT = 7071067811865470000
SQRT2PI = 2506628274631000502
def hart_tail(z):  # c(z) = Phi(-z), z >= 0 WAD
    if z > 37 * WAD: return 0
    e = expWad(-(z * z // WAD // 2))
    if z < SPLIT:
        n = N6
        for c in (N5, N4, N3, N2, N1, N0): n = n * z // WAD + c
        d = M7
        for c in (M6, M5, M4, M3, M2, M1, M0): d = d * z // WAD + c
        c = e * n // d
    else:
        f = z + WAD * WAD // (z + 2 * WAD * WAD // (z + 3 * WAD * WAD // (z + 4 * WAD * WAD // (z + 65 * WAD // 100))))
        c = e * WAD // (f * SQRT2PI // WAD)
    return min(c, WAD // 2)      # clamp -> c(0) <= 1/2 guarantees monotone assembly across 0
def hart_cdf(x):
    return hart_tail(-x) if x <= 0 else WAD - hart_tail(x)

worst = 0; arg = None
for i in range(-9000, 9001):
    x = i * 10**15
    e = abs(hart_cdf(x) - mp.ncdf(mp.mpf(x) / WAD) * WAD)
    if e > worst: worst, arg = e, x / WAD
print(f"\nHart/West WAD port: max abs err on [-9,9] step 1e-3 = {mp.nstr(worst,4)} wei (= {mp.nstr(worst/WAD,3)}) at x={arg}")
viol = 0; md = 0; tot = 0
for c in [-7.1, -2.5, -1.3, -0.4, 0, 0.3, 1.1, 2.7, 4.9, 7.07]:
    base = int(c * WAD) - 2500 * 997
    prev = hart_cdf(base)
    for i in range(1, 5001):
        cur = hart_cdf(base + i * 997); tot += 1
        if cur < prev: viol += 1; md = max(md, prev - cur)
        prev = cur
for _ in range(100000):
    x = random.randint(-9 * WAD, 9 * WAD); y = x + random.randint(1, 10**random.randint(0, 17)); tot += 1
    a, b = hart_cdf(x), hart_cdf(y)
    if b < a: viol += 1; md = max(md, a - b)
print(f"Hart/West WAD port monotonicity: {tot} ordered pairs, decreases={viol}, max drop={md} wei")
print("Hart symmetry max |cdf(x)+cdf(-x)-1e18| over 20k:", max(abs(hart_cdf(x) + hart_cdf(-x) - WAD) for x in (random.randint(1, 9*WAD) for _ in range(20000))))
