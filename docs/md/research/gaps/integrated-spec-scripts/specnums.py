import spec, numpy as np
from scipy.stats import norm
sig=0.55
for ch in ('L1','L2'):
  dt=spec.CHAIN[ch]['dt_s']; g=spec.gamma_S(sig,dt)
  for w in (30,120,240):
    for tau_min in (1440, 480, w+5):
        ws=w*60; tau=tau_min*60
        _,v=spec.asian_mu_v(0,sig,tau,ws,dt); vE=sig**2*tau/spec.YEAR_S
        gt=g*norm.pdf(0)/np.sqrt(v); gtE=g*norm.pdf(0)/np.sqrt(vE)
        qe=spec.q_epoch_tokens(ch,sig,tau,ws); 
        print(f"{ch} w={w:3d} tau={tau_min:5d}m sqrt(v/vEuro)={np.sqrt(v/vE):.3f} ATM gamma term Asian {100*gt:.2f}c (Euro {100*gtE:.2f}c) Q_epoch ATM {qe:,.0f} tokens; ATM price diff Asian-Euro {100*(norm.cdf(-0.5*sig**2*(tau-ws+( ws/dt-1)*dt/2)/spec.YEAR_S/np.sqrt(v))-norm.cdf(-0.5*np.sqrt(vE))):+.3f}c; +1sd(Euro) diff {100*(spec.price_binary(np.sqrt(vE),sig,tau,ws,dt)-norm.cdf(np.sqrt(vE)/np.sqrt(vE)-0.5*np.sqrt(vE))):+.2f}c")
print('gamma_S L1', spec.gamma_S(sig,12), 'L2', spec.gamma_S(sig,2))
for h in (0.0025,0.005,0.01):
    print('ramp h',h,'Qsafe L1 w=30m h0=1c', spec.q_safe_ramp('L1',1800,h,0.01), 'w=2h', spec.q_safe_ramp('L1',7200,h,0.01), ' Q_epoch floor c*2h', spec.CHAIN['L1']['c_manip']*2*h)
