import json, spec
cfgs=[]; lats=[]; seen=set()
for ch in ('L1','L2'):
  for k in ('normal','t'):
    for w in (30,120,240):
      for h0 in (0.005,0.01,0.02):
        for cut in ('wb','c10','c05'):
          if h0==0.005 and cut=='c05': continue
          dt=spec.CHAIN[ch]['dt_s']; ws=w*60
          cm={'wb':spec.cut_window(ws),'c10':spec.cut_tenor10(86400,ws),'c05':spec.cut_05(h0,ws,dt)}[cut]
          if cm > 12*3600: continue
          for lam in (0.1,0.5):
            key=(ch,k,w,h0,round(cm),lam)
            if key in seen: continue
            seen.add(key)
            cfgs.append(dict(chain=ch,kernel=k,w=w,h0=h0,cut=cut,lam_block=lam,sig='rv_ewma'))
            lats.append(dict(chain=ch,kernel=k,w=w,h0=h0,cut=cut,lam_block=lam))
print(len(cfgs))
json.dump(cfgs,open('cfgB.json','w')); json.dump(lats,open('cfgL.json','w'))
