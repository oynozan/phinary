import importlib.util, math
spec = importlib.util.spec_from_file_location("m2", "02_cdf_fixedpoint.py"); m2 = importlib.util.module_from_spec(spec); spec.loader.exec_module(m2)
for f,name in [(m2.choudhury,"Choudhury"),(m2.as_7126,"A&S7.1.26"),(m2.hart_west,"Hart")]:
    print(name, "Phi(-1e-12)=%.12f Phi(0)=%.12f Phi(+1e-12)=%.12f drop=%.3e" % (f(-1e-12), f(0.0), f(1e-12), f(-1e-12)-f(1e-12)))
WAD=m2.WAD
a=max(m2.solstat_cdf(-x) for x in [10**6,10**7,10**8,10**9]); b=min(m2.solstat_cdf(x) for x in [10**6,10**7,10**8,10**9])
print("solstat max drop across 0 ~", (a-b)/WAD)
# tick of ETH/USDC (native ETH = currency0, USDC currency1, decimals 18/6)
S=4000; raw=S*1e-12
print("tick(S=4000, ETH/USDC native)=", math.floor(math.log(raw)/math.log(1.0001)))
# kappa(s) from MC numbers in out04
for s,arb in [(0.002,81254),(0.005,45190),(0.01,22079)]:
    k=arb/124016; print(f"s={s}: kappa={k:.3f}  break-even noise volume V*/ell = kappa*P0(1-P0)/(2s) = {k*0.24993/(2*s):.1f}")
