import json,urllib.request,numpy as np
H=300; lastGrid=1790349203//H  # fork block timestamp ~1790349203 (last v3 write), adapter lastGrid = floor(now/H)
gA=lastGrid-85
start=(gA-1)*H*1000; end=lastGrid*H*1000
u=f"https://data-api.binance.vision/api/v3/klines?symbol=ETHUSDT&interval=1m&startTime={start}&endTime={end}&limit=1000"
k=json.load(urllib.request.urlopen(urllib.request.Request(u,headers={'User-Agent':'Mozilla/5.0'}),timeout=60))
# time-average of log price per 5-min window using 1-min (open+close)/2 as the minute's average proxy
t=np.array([r[0] for r in k])//1000; lo=np.log((np.array([float(r[1]) for r in k])+np.array([float(r[4]) for r in k]))/2)
g=(t//H)+1  # minute starting at t belongs to window ending at ((t//H)+1)*H
ws=sorted(set(g)); A=np.array([lo[g==w].mean() for w in ws])
d=np.diff(A); rv=1.5*(d**2).sum()/(len(d)*H)*31536000
cl=np.log(np.array([float(r[4]) for r in k])); pt=cl[4::5]; rvp=(np.diff(pt)**2).sum()/((len(pt)-1)*H)*31536000
print("minutes",len(k),"windows",len(ws),"Binance 5-min TWAP-return RV sigma",np.sqrt(rv),"5-min point RV sigma",np.sqrt(rvp))
