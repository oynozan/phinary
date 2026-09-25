# Calibration of the TWAP-return RV estimator (VolOracleV2 semantics) on simulated pool paths.
# Oracle semantics: tick prevailing over block b's interval (t_{b-1}, t_b] is the pool tick at the END of block b-1.
# D_g = sum over the 25 blocks of window g of 12 * p_{b-1}; RV = 1.5*ln(1.0001)^2 * sum clamp(D_g - D_{g-1})^2 / (H^3 n).
import numpy as np, json, sys, struct
from scipy.stats import chi2
LN=np.log(1.0001); YR=31536000; DB=12; H=300; M=H//DB; CAP=400
T0=1_790_000_100 - (1_790_000_100 % H)  # multiple of H (and of 12)
def pool_path(model, sigma, nb, rng, gamma=5e-4, p_act=0.576):
    s=sigma*np.sqrt(DB/YR)
    x=-197300*LN + np.cumsum(s*rng.standard_normal(nb))
    x=np.concatenate([[-197300*LN],x])            # x[0] = start, x[b] = end of block b
    if model=='exact':
        p=x.copy(); act=np.ones(nb+1,bool)
    elif model=='activity':
        act=rng.random(nb+1)<p_act; act[0]=True
        idx=np.maximum.accumulate(np.where(act,np.arange(nb+1),0))
        p=x[idx]
    elif model=='band':
        p=np.empty(nb+1); p[0]=x[0]; cur=x[0]
        for b in range(1,nb+1):
            e=cur-x[b]
            if e>gamma: cur=x[b]+gamma
            elif e<-gamma: cur=x[b]-gamma
            p[b]=cur
        act=np.concatenate([[True],np.diff(np.floor(p/LN))!=0])  # a swap happens iff the pool moved (tick change)
    tick=np.floor(p/LN).astype(np.int64)
    return tick, act
def estimator(tick, nb, cap=CAP):
    # prevailing tick in block b (1..nb) is tick[b-1]
    prev=tick[:-1]
    nw=nb//M
    D=(prev[:nw*M].reshape(nw,M).sum(1))*DB           # D_g for g = 1..nw (window g covers blocks (g-1)M+1..gM)
    d=np.diff(D)
    capD=cap*H
    d=np.clip(d,-capD,capD)
    dq=int((d.astype(np.int64)**2).sum()); n=len(d)
    var_sec=1.5*LN**2*dq/(H**3*n)
    return dq,n,var_sec,D
def encode(t0,gA,gB,dq,dN,times,ticks):
    w=lambda v: int(v).to_bytes(32,'big',signed=True)
    head=[w(t0),w(gA),w(gB),w(dq),w(dN)]
    off1=32*7; off2=off1+32*(1+len(times))
    body=w(len(times))+b''.join(w(t) for t in times)+w(len(ticks))+b''.join(w(k) for k in ticks)
    return b''.join(head)+w(off1)+w(off2)+body
if __name__=="__main__":
    mode=sys.argv[1]
    if mode=="files":
        rng=np.random.default_rng(20260926)
        nb=3*86400//DB
        for model,k in (("exact",6),("band",3)):
            for i in range(k):
                tick,act=pool_path(model,0.5,nb,rng)
                dq,n,v,D=estimator(tick,nb)
                # writes: at every active block b>=1: write(T0+12b, tick[b-1]); init at T0 with tick[0]
                bs=[b for b in range(1,nb+1) if act[b]]
                times=[T0+DB*b for b in bs]; ticks=[int(tick[b-1]) for b in bs]
                # checkpoints: gA = T0/H + 1 (end of window 1), gB = T0/H + nw
                gA=T0//H+1; gB=T0//H+nb//M
                # sanity: the last window's D requires a write at/after gB*H: ensure final block is written
                if not act[nb]: times.append(T0+DB*nb); ticks.append(int(tick[nb-1]))
                open(f"../oracle/data/{model}_{i}.bin","wb").write(encode(T0,gA,gB,dq,n,[T0]+times,[int(tick[0])]+ticks))
                print(model,i,"writes",len(times),"dq",dq,"n",n,"sigma_hat",np.sqrt(v*YR))
    else:
        paths=int(sys.argv[2]); days=float(sys.argv[3])
        nb=int(days*86400/DB); out={}
        for model in ("exact","activity","band"):
            for sigma in ((0.3,0.5,0.8) if model!="activity" else (0.5,)):
                rng=np.random.default_rng(hash((model,sigma))%2**32)
                r=[];cov=0;cov99=0
                for j in range(paths if model!="band" else max(paths//4,100)):
                    tick,act=pool_path(model,sigma,nb,rng)
                    dq,n,v,_=estimator(tick,nb)
                    ratio=v*YR/sigma**2; r.append(ratio)
                    nu=n/1.125
                    lo,hi=chi2.ppf(0.025,nu)/nu,chi2.ppf(0.975,nu)/nu
                    cov+= lo<=ratio<=hi
                    lo,hi=chi2.ppf(0.005,nu)/nu,chi2.ppf(0.995,nu)/nu
                    cov99+= lo<=ratio<=hi
                r=np.array(r); m=len(r)
                out[f"{model}|{sigma}"]=dict(paths=m,n=n,mean=r.mean(),se=r.std()/np.sqrt(m),sd=r.std(),sd_theory=np.sqrt(2*1.125/n),cov95=cov/m,cov99=cov99/m)
                print(model,sigma,out[f"{model}|{sigma}"],flush=True)
        json.dump(out,open(f"calib_{paths}_{days}.json","w"),indent=1)
