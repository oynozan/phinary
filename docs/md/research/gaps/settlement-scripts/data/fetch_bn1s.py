import json, subprocess, sys
S=int(sys.argv[1])*1000; E=int(sys.argv[2])*1000
rows=[]; t=S
while t<E:
    o=subprocess.run(["curl","-s","--max-time","30",f"https://data-api.binance.vision/api/v3/klines?symbol=ETHUSDT&interval=1s&startTime={t}&endTime={E}&limit=1000"],capture_output=True,text=True).stdout
    try: k=json.loads(o)
    except Exception: continue
    if not k: break
    rows+=[[r[0]//1000,float(r[4])] for r in k]; t=k[-1][0]+1000
json.dump(rows,open("bn1s.json","w")); print(len(rows))
