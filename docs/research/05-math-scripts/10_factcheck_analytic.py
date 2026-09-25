import mpmath as mp
from scipy.stats import chi2, norm
from scipy.optimize import minimize_scalar
import math
mp.mp.dps=50
Y=mp.mpf(365)
def d2f(S,K,s,T,b=0): return (mp.log(mp.mpf(S)/K)+(b-s**2/2)*T)/(s*mp.sqrt(T))
def P(S,K,s,T,r=0,b=0): return mp.e**(-r*T)*mp.ncdf(d2f(S,K,s,T,b))
s=mp.mpf('0.8');T=30/Y
d2=d2f(4000,5000,s,T); d1=d2+s*mp.sqrt(T)
print("R2 d2",mp.nstr(d2,8),"YES",mp.nstr(P(4000,5000,s,T),13))
print("delta",mp.nstr(mp.npdf(d2)/(4000*s*mp.sqrt(T)),6),"vega",mp.nstr(-mp.npdf(d2)*d1/s,6),"theta/day",mp.nstr(mp.npdf(d2)*d1/(2*T)/365,6))
print("delta FD",mp.nstr(mp.diff(lambda x:P(x,5000,s,T),4000),6),"vega FD",mp.nstr(mp.diff(lambda v:P(4000,5000,v,T),s),6),"theta FD/day", mp.nstr(-mp.diff(lambda t:P(4000,5000,s,t),T)/365,6))
r=mp.mpf('0.05'); print("r=b=5%: YES",mp.nstr(P(4000,5000,s,T,r,r),12),"NO",mp.nstr(mp.e**(-r*T)*mp.ncdf(-d2f(4000,5000,s,T,r)),12))
print("b=5% r_c=0 YES", mp.nstr(P(4000,5000,s,T,0,r),6))
# rows
for (S,K,sg,Td) in [(4000,4000,0.8,30),(4000,4400,0.6,7),(4000,4040,0.6,1),(4000,4000,0.6,1/24),(3000,5000,0.8,97)]:
    print("row",S,K,sg,Td, mp.nstr(P(S,K,mp.mpf(sg),Td/Y),12))
# delta max
K=5000;Sst=K*mp.e**(-s**2/2*T); print("S*",mp.nstr(Sst,9),"dmax",mp.nstr(mp.npdf(d2f(Sst,K,s,T))/(Sst*s*mp.sqrt(T)),9),"formula",mp.nstr(1/(K*s*mp.sqrt(2*mp.pi*T)),9))
# max price change per 1% spot move: linear formula vs exact max over S of P(1.01S)-P(S)
for sg,Td in [(0.8,30),(0.6,1),(0.6,1/24)]:
    sg=mp.mpf(sg);TT=Td/Y
    lin=mp.mpf('0.01')/(sg*mp.sqrt(2*mp.pi*TT))
    f=lambda x: -float(P(1.01*math.exp(x),1,sg,TT)-P(math.exp(x),1,sg,TT))
    res=minimize_scalar(f,bounds=(-1,1),method='bounded',options={'xatol':1e-12})
    print("1%move sigma",sg,"Td",Td,"linear",mp.nstr(lin,5),"exact max",-res.fun)
# ATM
print("ATM 30d",mp.nstr(P(1,1,s,T),5),"1y",mp.nstr(P(1,1,s,1),5))
print("sigma limits", [mp.nstr(P(1,1,mp.mpf(v),T),4) for v in (1,10,100)])
Kv=4000*mp.e**(s**2/2*T); print("Kv",mp.nstr(Kv,7))
# NR constant sum
c=[-1.26551223,1.00002368,0.37409196,0.09678418,-0.18628806,0.27886807,-1.13520398,1.48851587,-0.82215223,0.17087277]
print("NR const sum", mp.fsum([mp.mpf(str(x)) for x in c]))
# Choudhury and A&S
def chou(x):
    v=math.exp(-x*x/2)/(2260/3989+6400/3989*abs(x)+3300/3989*math.sqrt(x*x+3)); return 1-v if x>0 else v
def AS(x):
    z=abs(x)/math.sqrt(2); t=1/(1+0.3275911*z)
    e=1-t*(0.254829592+t*(-0.284496736+t*(1.421413741+t*(-1.453152027+t*1.061405429))))*math.exp(-z*z)
    return 0.5*(1+(e if x>=0 else -e))
xs=[i*1e-3 for i in range(-9000,9001)]
print("Choudhury max err",max(abs(chou(x)-norm.cdf(x)) for x in xs),"drop", chou(-1e-12)-chou(1e-12))
print("A&S max err",max(abs(AS(x)-norm.cdf(x)) for x in xs))
# tick
print("tick S=4000 native", math.floor(mp.log(mp.mpf(4000)*mp.mpf(10)**-12)/mp.log(mp.mpf('1.0001'))))
print("Phi(-8.8)*1e18", mp.ncdf(-8.8)*1e18, "x where Phi=1e-18", mp.findroot(lambda x: mp.ncdf(x)-mp.mpf('1e-18'), -8.7))
# chi2 multipliers
n=288; print("CI mult", math.sqrt(n/chi2.ppf(0.975,n)), math.sqrt(n/chi2.ppf(0.025,n)))
# sample sizes
za=norm.ppf(0.975); zb=norm.ppf(0.8)
for d in (0.02,0.01,0.005): print("n per bin",d, math.ceil((za+zb)**2*0.25/d**2))
# HL p-values
print("HL 7.26 df8 p",chi2.sf(7.26,8),"df10 p",chi2.sf(7.26,10))
# per-block std, tau*
n0=float(mp.npdf(0))
for tau in (60,300,3600,86400): print("perblock std",tau, n0*math.sqrt(12/tau))
for sp in (0.005,0.01,0.02,0.05): print("tau*",sp, 12*(n0/sp)**2/3600,"h", 1*(n0/sp)**2/60,"min")
# pin
for h in (0.01,0.1,0.25,0.5): print("share",h,1+2/math.pi*math.asin(h-1))
# TWAP max diff
def maxdiff(tau,w,sg=0.8):
    tau/=365*86400; w/=365*86400
    best=0
    for i in range(-4000,4001):
        x=i*1e-4*sg*math.sqrt(tau)*3
        e=norm.cdf((x-sg*sg/2*tau)/(sg*math.sqrt(tau)))
        g=norm.cdf((x-sg*sg/2*(tau-w/2))/(sg*math.sqrt(tau-2*w/3)))
        best=max(best,abs(g-e))
    return best
for tau,w in [(3600,300),(3600,1800),(86400,300),(86400,1800),(7*86400,300),(7*86400,1800)]:
    print("twap diff",tau,w,maxdiff(tau,w),"sig=0.3",maxdiff(tau,w,0.3))
# geometric closed form ATM 1h w=30m sigma 0.8
tau=1/8760; w=tau/2; sg=0.8
print("G ATM 1h", norm.cdf((-sg*sg/2*(tau-w/2))/(sg*math.sqrt(tau-2*w/3))))
# flip prob, q_safe, C(delta)
def sq(tau_s): return 0.8*math.sqrt(tau_s/(365*86400))
print("flip 1d 5bp", 2*0.0005*n0/(0.8*math.sqrt((86400-1200)/(365*86400))), "7d", 2*0.0005*n0/sq(7*86400), "30bp 1d",2*0.003*n0/sq(86400))
for D1,f in [(1e6,5e-4),(5e6,5e-4),(20e6,3e-3)]:
    print("qsafe",D1,f,[round(f*200*D1*sq(t)/n0) for t in (7*86400,86400,3600,300)])
def C(D1,f,d,blocks): LS=200*D1; return LS*(f*d+blocks*max(d-f,0)*(d+3*f)/4)
print("C", [round(C(5e6,5e-4,d,150)) for d in (5e-4,1e-3,5e-3)], round(C(5e6,5e-4,5e-3,1800)), [round(C(5e6,3e-3,d,150)) for d in (5e-4,1e-3,5e-3)])
# EWMA
for l in (0.94,0.97,0.99,0.997): ne=(1+l)/(1-l); print("ewma",l,ne,1/math.sqrt(2*ne))
# LVR bound
P0=float(P(1,1,s,1/Y)); print("P0",P0,"bound",1e6*P0*(1-P0)/2)
print("sizing ell", 2*10000/(0.364*P0*(1-P0)))
# tick quant bias
print("tickbias 12s",1+math.log(1.0001)**2/(6*0.64*12/(365*86400)))
# Merton total vol
print("merton total vol", math.sqrt(0.36+10*(0.05**2+0.08**2)))
# drift bias
m=3-0.32; print("drift bias", m*m*300/(365*86400))
