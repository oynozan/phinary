import glob, pickle, spec
rows=[]
for f in glob.glob('out/latB/*.pkl'):
    r=pickle.load(open(f,'rb')); c=r['cfg']
    ws=c['w']*60; dt=spec.CHAIN[c['chain']]['dt_s']
    cm={'wb':spec.cut_window(ws),'c10':spec.cut_tenor10(86400,ws),'c05':spec.cut_05(c['h0'],ws,dt)}[c['cut']]/60
    rows.append((c['chain'],c['kernel'],c['w'],c['h0'],round(cm),c['lam_block'],r['lat'][2.0],r['lat'][5.0]))
rows.sort()
for ch,k,w,h0,cm,lam,a,b in rows:
    print(f"{ch} {k:6s} w={w:3d} h0={h0:.3f} cut={cm:4d}m lam={lam}: D=2 lat {a['total']:+.4f}±{a['se']:.4f} (own {a['own']:+.4f} crowd {a['crowd']:+.4f}, vol {a['vol']:.2f}) noiseP&L {a['noise_pnl']:+.3f} | D=5 lat {b['total']:+.4f}±{b['se']:.4f} noiseP&L {b['noise_pnl']:+.3f}")
