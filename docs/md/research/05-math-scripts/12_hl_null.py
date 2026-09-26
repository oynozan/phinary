import numpy as np
rng=np.random.default_rng(1); st=[]
for _ in range(2000):
    p=rng.beta(1.2,1.8,20000); o=rng.random(20000)<p
    q=np.quantile(p,np.linspace(0,1,11)); g=np.clip(np.searchsorted(q,p,side='right')-1,0,9)
    H=0
    for k in range(10):
        m=g==k; E=p[m].sum(); O=o[m].sum(); n=m.sum(); H+=(O-E)**2/(E*(1-E/n))
    st.append(H)
st=np.array(st); print("mean HL under perfect calibration (fixed p, 10 deciles):",st.mean(),"var",st.var(),"(chi2_10: 10,20; chi2_8: 8,16)")
