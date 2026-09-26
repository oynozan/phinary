"""Fetch 2 days of mainnet v3 USDC/WETH 5 bp Swap logs (token0 = USDC, token1 = WETH) for a same-period L1 comparison."""
import json, subprocess, time, sys, gzip
T0="0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
urls=["https://ethereum-rpc.publicnode.com","https://mainnet.gateway.tenderly.co","https://rpc.mevblocker.io"]
addr="0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640"
def rpc(m,p,tries=9):
    last=None
    for k in range(tries):
        u=urls[k%len(urls)]
        try:
            o=subprocess.run(["curl","-s","--max-time","90","-X","POST",u,"-H","Content-Type: application/json","-d",json.dumps({"jsonrpc":"2.0","id":1,"method":m,"params":p})],capture_output=True,text=True).stdout
            j=json.loads(o)
            if "result" in j: return j["result"]
            last=j.get("error")
        except Exception as e: last=str(e)
        time.sleep(1+k)
    raise Exception(f"fail {m} {last}")
def s256(b): return int.from_bytes(b,'big',signed=True)
head=int(rpc("eth_blockNumber",[]),16)-5; start=head-int(2.05*7200)
rows=[]; b=start; step=500
while b<=head:
    e=min(head,b+step-1)
    try: res=rpc("eth_getLogs",[{"address":addr,"topics":[T0],"fromBlock":hex(b),"toBlock":hex(e)}])
    except Exception as ex: print("shrink",ex,file=sys.stderr); step=max(50,step//2); continue
    for l in res:
        d=bytes.fromhex(l["data"][2:])
        rows.append([int(l["blockNumber"],16),int(l["transactionIndex"],16),int(l["logIndex"],16),int(l.get("blockTimestamp","0x0"),16),
                     str(s256(d[0:32])),str(s256(d[32:64])),str(int.from_bytes(d[64:96],'big')),str(int.from_bytes(d[96:128],'big')),s256(d[128:160])])
    b=e+1
json.dump({"chain":"eth","pool":addr,"start":start,"head":head,"swaps":rows},gzip.open("data/swaps_eth.json.gz","wt"))
print("done",start,head,len(rows),sum(1 for r in rows if r[3]==0))
