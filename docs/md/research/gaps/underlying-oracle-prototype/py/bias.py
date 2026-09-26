# Fee-band bias of RV estimators on a band-follower pool path (block-level arbitrage).
import numpy as np, json, sys
LN=np.log(1.0001); YR=365*86400; DB=12
def sim(sigma,gamma,days=1,paths=400,noise=0.0,seed=0,H_list=(60,300,900,3600)):
    rng=np.random.default_rng(seed)
    nb=int(days*86400/DB)
    s=sigma*np.sqrt(DB/YR)
    x=np.zeros(paths); p=np.zeros(paths)
    ticks=np.empty((nb,paths),dtype=np.int64)
    for i in range(nb):
        x+=s*rng.standard_normal(paths)
        if noise>0:
            p+=noise*gamma*rng.standard_normal(paths)*(rng.random(paths)<0.5)
        e=p-x
        p=np.where(e>gamma,x+gamma,np.where(e<-gamma,x-gamma,p))
        ticks[i]=np.floor(p/LN).astype(np.int64)
    out={}
    for H in H_list:
        m=H//DB; nw=nb//m
        tk=ticks[:nw*m].reshape(nw,m,paths)
        pt=tk[:,-1,:].astype(float)            # point sample at window end
        mean=tk.mean(axis=1)                   # window-mean tick
        rv_pt=(np.diff(pt,axis=0)**2).sum(0)*LN**2/((nw-1)*H)*YR
        corr=1+1/(2*m*m)
        rv_tw=1.5*(np.diff(mean,axis=0)**2).sum(0)*LN**2/((nw-1)*H*corr)*YR
        out[H]=dict(point=rv_pt.mean()/sigma**2-1, twap=rv_tw.mean()/sigma**2-1,
                    point_se=rv_pt.std()/np.sqrt(paths)/sigma**2, twap_se=rv_tw.std()/np.sqrt(paths)/sigma**2,
                    c_point=-(rv_pt.mean()-sigma**2)/YR*H/gamma**2 if gamma>0 else 0,
                    c_twap=-(rv_tw.mean()-sigma**2)/YR*H/gamma**2 if gamma>0 else 0)
    return out
if __name__=="__main__":
    res={}
    for noise in (0.0,0.5):
        for gamma in (0.0,5e-4,6.25e-4,30e-4):
            for sigma in (0.3,0.5,0.8,1.2):
                if gamma==0 and noise>0: continue
                r=sim(sigma,gamma,noise=noise,seed=int(sigma*100+gamma*1e5+noise*10))
                res[f"{noise}|{gamma}|{sigma}"]=r
                print(f"noise={noise} gamma={gamma*1e4:.2f}bp sigma={sigma}: "+"  ".join(f"H={H}: pt {v['point']*100:+.1f}% tw {v['twap']*100:+.1f}%±{v['twap_se']*100:.1f} (c_tw {v['c_twap']:.2f})" for H,v in r.items()),flush=True)
    json.dump(res,open('bias_results.json','w'),indent=1)
