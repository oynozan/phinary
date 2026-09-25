import json, subprocess, sys, time, gzip
E=int(time.time())*1000; S=E-int(2.1*86400)*1000
rows=[]; t=S
while t<E:
    o=subprocess.run(["curl","-s","--max-time","30",f"https://data-api.binance.vision/api/v3/klines?symbol=ETHUSDT&interval=1s&startTime={t}&endTime={E}&limit=1000"],capture_output=True,text=True).stdout
    try: k=json.loads(o)
    except Exception: time.sleep(1); continue
    if not k or not isinstance(k,list): break
    rows+=[[r[0]//1000,float(r[4])] for r in k]; t=k[-1][0]+1000
json.dump(rows,gzip.open("data/bn1s.json.gz","wt")); print(len(rows), rows[0], rows[-1])
