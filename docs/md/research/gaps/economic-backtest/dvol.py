import json,urllib.request,time
start=1616457600000; end=int(time.time()*1000); rows={}
t=start
while t<end:
    e=min(end,t+1000*3600*1000)
    url=f"https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=ETH&start_timestamp={t}&end_timestamp={e}&resolution=3600"
    for k in range(5):
        try: d=json.load(urllib.request.urlopen(url,timeout=30))['result']['data']; break
        except Exception as ex: time.sleep(2); d=[]
    for r in d: rows[r[0]]=r[4]
    t=e
r=sorted(rows.items()); json.dump(r,open('dvol_1h.json','w')); print(len(r),r[0],r[-1])
