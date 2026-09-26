import json, subprocess, time, itertools, sys
RS=["https://mainnet.gateway.tenderly.co","https://rpc.mevblocker.io"]
rr=itertools.cycle(RS)
def rpc(m,p,tries=10):
    last=None
    for k in range(tries):
        R=next(rr)
        try:
            o=subprocess.run(["curl","-s","--max-time","60","-X","POST",R,"-H","Content-Type: application/json","-d",json.dumps({"jsonrpc":"2.0","id":1,"method":m,"params":p})],capture_output=True,text=True).stdout
            j=json.loads(o)
            if "result" in j: return j["result"]
            last=j
        except Exception as e: last=e
        time.sleep(1)
    raise Exception("fail "+m+str(last))
T0="0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
pools={"v3_5bp":"0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640","v3_30bp":"0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8","v3_1bp":"0xE0554a476A092703abdB3Ef35c80e0D76d32939F"}
head=int(rpc("eth_blockNumber",[]),16)
days=float(sys.argv[1]); start=head-int(days*7150)
def s256(b): return int.from_bytes(b,'big',signed=True)
out={}
for name,addr in pools.items():
    rows=[]; b=start; step=500
    while b<=head:
        e=min(head,b+step-1)
        try:
            res=rpc("eth_getLogs",[{"address":addr,"topics":[T0],"fromBlock":hex(b),"toBlock":hex(e)}])
        except Exception as ex:
            print("retry smaller",b,ex,file=sys.stderr); step=max(50,step//2); continue
        for l in res:
            d=bytes.fromhex(l["data"][2:])
            rows.append([int(l["blockNumber"],16),int(l["logIndex"],16),int(l.get("blockTimestamp","0x0"),16),
                         str(s256(d[0:32])),str(s256(d[32:64])),str(int.from_bytes(d[64:96],'big')),str(int.from_bytes(d[96:128],'big')),s256(d[128:160])])
        b=e+1
    out[name]=rows; print(name,len(rows),file=sys.stderr)
json.dump({"start":start,"head":head,"pools":out},open("swaps_%sd.json"%sys.argv[1],"w"))
print("done",start,head)
