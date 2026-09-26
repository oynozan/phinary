import numpy as np
from scipy.stats import norm
from math import sqrt, log
rng=np.random.default_rng(12345)
Y=365*86400; sig=0.8; S0=K=4000.0; dt=12; T=86400; nb=T//dt
def P(S,tau):
    tau=np.maximum(tau,1e-300); return norm.cdf((np.log(S/K)-0.5*sig**2*tau)/(sig*np.sqrt(tau)))
P0=float(P(np.array(S0),T/Y))
# terminal martingale check
Z=rng.standard_normal(2_000_000); ST=S0*np.exp(-0.5*sig**2*T/Y+sig*sqrt(T/Y)*Z)
print("E[1{ST>K}]",(ST>K).mean(),"+-",sqrt(P0*(1-P0)/2e6),"P0",P0)
# LVR with lag and TWAP quoting
npaths=1500; lam=1e-6
def run(s, lags=(1,50,150), twapW=150):
    x=np.full(npaths,log(S0)); hist=[x.copy()]*(max(lags)+1); tw=[x.copy()]*twapW
    arb={l:np.zeros(npaths) for l in lags}; arb['twap']=np.zeros(npaths); qv=np.zeros(npaths); Pprev=np.full(npaths,P0)
    for k in range(1,nb+1):
        x=x-0.5*sig**2*dt/Y+sig*sqrt(dt/Y)*rng.standard_normal(npaths)
        tau=(T-k*dt)/Y
        fair=(x>log(K)).astype(float) if k==nb else P(np.exp(x),tau)
        qv+=(fair-Pprev)**2; Pprev=fair
        if k==nb: break
        hist=hist[1:]+[x.copy()]; tw=tw[1:]+[x.copy()]
        for l in lags:
            q=P(np.exp(hist[-1-l] if l<=len(hist)-1 else hist[0]),tau)
            arb[l]+=np.maximum(np.abs(fair-q)-s,0)**2/(2*lam)
        q=P(np.exp(np.mean(tw[:-1],axis=0)),tau)   # geometric TWAP of previous 150 blocks
        arb['twap']+=np.maximum(np.abs(fair-q)-s,0)**2/(2*lam)
    return arb,qv
arb,qv=run(0.0,lags=(1,))
print("s=0 lag1 arb",arb[1].mean(),"+-",arb[1].std()/sqrt(npaths),"bound",P0*(1-P0)/(2*lam),"E[QV]",qv.mean(),"+-",qv.std()/sqrt(npaths),"P0(1-P0)",P0*(1-P0))
arb,_=run(0.002,lags=(1,5,25,50,150))
b=arb[1].mean()
for k,v in arb.items(): print("s=0.002",k,round(v.mean()),"x%.1f"%(v.mean()/b))
# fee band RV bias, block-level arbitrage model, sigma=0.8 and 0.5
for sg in (0.8,0.5):
    n=400; nbk=86400//12
    xx=np.cumsum(sg*sqrt(12/Y)*rng.standard_normal((n,nbk)),1)
    for fee in (5e-4,3e-3):
        p=np.zeros(n); pool=np.empty_like(xx)
        for k in range(nbk):
            d=xx[:,k]-p; p=np.where(d>fee,xx[:,k]-fee,np.where(d<-fee,xx[:,k]+fee,p)); pool[:,k]=p
        out=[]
        for every in (1,5,25,300):
            ps=pool[:,::every]; W=(ps.shape[1]-1)*every*12/Y
            out.append("%ds:%+.1f%%"%(every*12,((np.diff(ps,axis=1)**2).sum(1)/W).mean()/sg**2*100-100))
        print("feeband sigma",sg,"fee",fee,out)
