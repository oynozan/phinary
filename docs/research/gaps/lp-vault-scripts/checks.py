"""LP-vault layer numeric checks (gap report: lp-vault-structure-and-exposure-caps)."""
import random, math
from fractions import Fraction
from scipy.stats import norm
random.seed(7)

def ladder_min_linear(cash, strikes, invY, invN):
    # strikes sorted ascending; region 0: S<=K1 (all NO win) ... region n: S>Kn (all YES win)
    run = cash + sum(invN); mn = run; arg = 0
    for j in range(len(strikes)):
        run += invY[j] - invN[j]
        if run < mn: mn, arg = run, j+1
    return mn, arg

def wealth_at(S, cash, strikes, invY, invN):
    return cash + sum((y if S > k else n) for k, y, n in zip(strikes, invY, invN))

# ---- A: O(n) ladder min == brute force over a dense S grid (incl. S==K tie points)
bad = 0; trials = 20000; union_gap = []
for t in range(trials):
    n = random.randint(1, 30)
    strikes = sorted(random.sample(range(1000, 9000, 50), n))
    invY = [random.randint(0, 10**6) for _ in range(n)]
    invN = [random.randint(0, 10**6) for _ in range(n)]
    cash = random.randint(0, 10**7)
    mn, _ = ladder_min_linear(cash, strikes, invY, invN)
    grid = [strikes[0]-1] + [k for k in strikes] + [k+1 for k in strikes] + [k+25 for k in strikes] + [strikes[-1]+10**4]
    bf = min(wealth_at(S, cash, strikes, invY, invN) for S in grid)
    if bf != mn: bad += 1
    lb1 = cash + sum(min(y, n_) for y, n_ in zip(invY, invN))   # O(1) union bound
    assert lb1 <= mn
    union_gap.append(mn - lb1)
print(f"A ladder-min O(n) vs brute force: {trials} random ladders (n<=30), mismatches={bad}")
print(f"  union bound LB1<=exact always; mean slack exact-LB1 = {sum(union_gap)/len(union_gap):.0f} units")

# ---- B: per-market caps do not bound the ladder beyond their SUM; aligned exposure realises the sum
n=5; strikes=[4000,4500,5000,5500,6000]; q=100_000; c=q
# vault pre-minted c sets per market, sold q YES everywhere (inventory: invY=0, invN=c) at prices p
S0=5000; sig=0.6; tau=7/365
p=[norm.cdf((math.log(S0/k)-0.5*sig*sig*tau)/(sig*math.sqrt(tau))) for k in strikes]
prem=[pi*q for pi in p]
D = n*c                                # all capital pre-minted into sets
cash = D - n*c + sum(prem)
invY=[0]*n; invN=[c]*n
mn,arg=ladder_min_linear(cash,strikes,invY,invN)
per_mkt_loss=[c-prem[i]-min(invY[i],invN[i]) for i in range(n)]
print("B aligned ladder (vault sold YES at every strike): p =",[round(float(x),3) for x in p])
print(f"  per-market worst loss = {[round(x) for x in per_mkt_loss]} (each <= q)")
print(f"  sum per-market = {sum(per_mkt_loss):.0f}; exact ladder loss D-min W = {D-mn:.0f} at region {arg} (S>K_n)")
# offsetting ladder: vault sold YES at low strikes, NO at high strikes -> exact loss << sum
invY2=[0,0,0,c,c]; invN2=[c,c,c,0,0]
prem2=[p[i]*q if i<3 else (1-p[i])*q for i in range(n)]
cash2=D-n*c+sum(prem2)
mn2,arg2=ladder_min_linear(cash2,strikes,invY2,invN2)
pm2=[c-prem2[i]-min(invY2[i],invN2[i]) for i in range(n)]
print(f"  traders long the range (5000,5500]: vault sold YES@K<=5000 and NO@K>=5500: sum per-market={sum(pm2):.0f}, exact={D-mn2:.0f} region {arg2}")
invY3=[c,c,0,0,0]; invN3=[0,0,c,c,c]   # sold NO at low K, YES at high K ('strangle' short): regions between pay nothing
prem3=[(1-p[i])*q if i<2 else p[i]*q for i in range(n)]
cash3=D-n*c+sum(prem3); mn3,arg3=ladder_min_linear(cash3,strikes,invY3,invN3)
print(f"  offsetting: vault sold NO@K<=4500 and YES@K>=5000 (trader positions cannot all win): sum per-market={sum(c-prem3[i] for i in range(n)):.0f}, exact={D-mn3:.0f} region {arg3}")

# ---- C: sequential pro-rata claims: exact, monotone, no dust
worst=0
for t in range(20000):
    k=random.randint(1,40); shares=[random.randint(1,10**9) for _ in range(k)]
    S=sum(shares); C=random.randint(0,3*S)
    remS, remC = S, C; pps=Fraction(remC,remS); paid=[]
    order=list(range(k)); random.shuffle(order)
    for i in order:
        out = shares[i]*remC//remS
        fair_floor = shares[i]*C//S
        assert out >= fair_floor
        remS-=shares[i]; remC-=out; paid.append(out)
        if remS: 
            new=Fraction(remC,remS); assert new>=pps; pps=new
    assert remC==0 and sum(paid)==C
    worst=max(worst, max(abs(shares[i]*C/S - paid[j]) for j,i in enumerate(order)))
print(f"C sequential pro-rata: 20000 random claim orders: sum(payouts)==final cash exactly, remaining pps non-decreasing; max |payout-fair| = {worst:.2f} units")

# ---- D: first-depositor / inflation
def naive(att_dep, donation, victim, offset=None, internal=False):
    # returns attacker profit (units). offset None => no virtual shares; internal=True => donation ignored
    supply=0; assets=0
    def cts(a):
        if offset is None:
            return a if supply==0 else a*supply//assets
        return a*(supply+10**offset)//(assets+1)
    s_att=cts(att_dep); supply+=s_att; assets+=att_dep
    if not internal: assets+=donation
    s_v=cts(victim)
    if s_v==0 and offset is None: pass
    supply+=s_v; assets+=victim
    def cta(s):
        if offset is None: return s*assets//supply
        return s*(assets+1)//(supply+10**offset)
    att_out=cta(s_att)
    return att_out-att_dep-(donation if not internal else 0), victim - (cta(s_v) if s_v else 0)
U=10**6
for label,kw in [("naive balanceOf, no offset",dict()),("OZ virtual offset 0",dict(offset=0)),("OZ virtual offset 6",dict(offset=6)),("internal ledger, 1:1 subscription",dict(internal=True))]:
    prof,vloss=naive(1, 10_000*U, 10_000*U - 1, **kw)
    print(f"D inflation [{label}]: attacker 1 unit + donate 10k USDC, victim 9,999.999999 USDC -> attacker P&L {prof/U:+.6f} USDC, victim loss {vloss/U:.6f} USDC")

# ---- E: mark-to-model NAV sensitivity (why mid-life entry/exit is dangerous near expiry)
sig=0.6
for tau_h in [168,24,1]:
    tau=tau_h/8760
    dPdlnS = norm.pdf(-0.5*sig*sig*tau/(sig*math.sqrt(tau)))/(sig*math.sqrt(tau))
    inv=200_000; nav=1_000_000
    dnav = inv*dPdlnS*0.005
    print(f"E ATM digital tau={tau_h}h: dP/dlnS={dPdlnS:.2f}; 0.5% spot push moves 200k-unit net inventory by ${dnav:,.0f} = {100*dnav/nav:.1f}% of a $1M NAV")
# manipulation cost on a CPMM-like pool: round trip fee cost ~ f * V * delta (V = virtual TVL in-range)
for V in [1e7,1e8]:
    for f in [5e-4,3e-3]:
        cost=f*V*0.005
        print(f"  push 0.5% on V=${V:,.0f} virtual liquidity, fee {f*1e4:.0f}bp: round-trip fee cost ~ ${cost:,.0f}")

# ---- F: generalized per-market budget == 05 §3.3 form
for t in range(10000):
    c=random.randint(0,10**6); y=random.randint(0,c+10**6); nn=random.randint(0,c+10**6); pnl=random.randint(-10**6,10**6); B=random.randint(0,10**6)
    loss_yes=c-pnl-y; loss_no=c-pnl-nn
    assert (max(loss_yes,loss_no)<=B) == (pnl+min(y,nn) >= c-B)
print("F per-market form: max_o loss_m <= B_m  <=>  pnlCash_m + min(invY,invN) >= c_m - B_m (10k random cases); with c_m=0 and netting this is U0-U<=B_m")

# ---- G: capital efficiency of the exact ladder cap vs the O(1) union bound under random two-sided flow
import statistics
ratios=[]
for t in range(2000):
    n=9; strikes=[3000+250*i for i in range(n)]; S0=4000; tau=7/365
    p=[norm.cdf((math.log(S0/k)-0.5*sig*sig*tau)/(sig*math.sqrt(tau))) for k in strikes]
    c=10**6; invY=[c]*n; invN=[c]*n; cash=0.0; D=n*c
    for _ in range(200):
        i=random.randrange(n); q=random.randint(1,20000); side=random.random()
        h=0.01
        if side<0.35 and invY[i]>=q: invY[i]-=q; cash+=(p[i]+h)*q          # trader buys YES
        elif side<0.7 and invN[i]>=q: invN[i]-=q; cash+=(1-p[i]+h)*q       # trader buys NO
        elif side<0.85 and invY[i]+q<=2*c and cash>=(p[i]-h)*q: invY[i]+=q; cash-=(p[i]-h)*q   # trader sells YES back
        elif cash>=(1-p[i]-h)*q and invN[i]+q<=2*c: invN[i]+=q; cash-=(1-p[i]-h)*q            # trader sells NO back
    exact=D-ladder_min_linear(cash,strikes,invY,invN)[0]
    union=D-(cash+sum(min(a,b) for a,b in zip(invY,invN)))
    if union>0: ratios.append(max(exact,0)/union)
print(f"G random two-sided flow, 9 strikes, 200 trades: exact worst-case loss / union bound: median {statistics.median(ratios):.2f}, p10 {sorted(ratios)[len(ratios)//10]:.2f}, p90 {sorted(ratios)[9*len(ratios)//10]:.2f} (n={len(ratios)})")
