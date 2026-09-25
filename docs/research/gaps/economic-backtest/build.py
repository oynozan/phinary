import zipfile,glob,numpy as np,io
ts=[];cl=[]
for f in sorted(glob.glob('ETHUSDT-1m-*.zip')):
    z=zipfile.ZipFile(f); raw=z.read(z.namelist()[0]).decode()
    lines=[l for l in raw.splitlines() if l and l[0].isdigit()]
    a=np.array([(int(l.split(',')[0]),float(l.split(',')[4])) for l in lines])
    t=a[:,0].astype(np.int64)
    t=np.where(t>1e14,t//1000,t)  # microseconds -> ms
    ts.append(t); cl.append(a[:,1])
ts=np.concatenate(ts); cl=np.concatenate(cl)
o=np.argsort(ts); ts=ts[o]; cl=cl[o]
u=np.unique(ts,return_index=True)[1]; ts=ts[u]; cl=cl[u]
# regular grid, forward-fill gaps
t0=ts[0]; n=int((ts[-1]-t0)//60000)+1
grid=np.full(n,np.nan); idx=((ts-t0)//60000).astype(int); grid[idx]=cl
miss=np.isnan(grid).sum()
# gaps
g=np.diff(idx); print('rows',len(ts),'grid',n,'missing',miss,'max gap min',g.max())
for i in range(1,n):
    if np.isnan(grid[i]): grid[i]=grid[i-1]
np.savez_compressed('eth1m.npz',t0=t0,px=grid)
import datetime; print(datetime.datetime.utcfromtimestamp(t0/1000), datetime.datetime.utcfromtimestamp((t0+(n-1)*60000)/1000))
