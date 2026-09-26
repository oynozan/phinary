"""Fetch 2 days of Uniswap v3 Swap logs for the Arbitrum / Base 5 bp WETH/USDC pools (token0 = WETH, token1 = USDC)."""
import json, subprocess, time, sys, gzip
T0="0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
CFG={"arb":(["https://arb1.arbitrum.io/rpc","https://arbitrum.gateway.tenderly.co"],"0xC6962004f452bE9203591991D15f6b388e09E8D0",50000,4.0),
     "base":(["https://mainnet.base.org","https://base-rpc.publicnode.com"],"0xd0b53D9277642d899DF5C87A3966A349A798F224",2000,0.5)}
chain=sys.argv[1]; days=float(sys.argv[2])
urls,addr,step,bps=CFG[chain]
def rpc(m,p,tries=8):
    last=None
    for k in range(tries):
        u=urls[k%len(urls)]
        try:
            o=subprocess.run(["curl","-s","--max-time","90","-X","POST",u,"-H","Content-Type: application/json","-d",json.dumps({"jsonrpc":"2.0","id":1,"method":m,"params":p})],capture_output=True,text=True).stdout
            j=json.loads(o)
            if "result" in j: return j["result"]
            last=j.get("error")
        except Exception as e: last=str(e)
        time.sleep(1+2*k)
    raise Exception(f"fail {m} {last}")
def s256(b): return int.from_bytes(b,'big',signed=True)
head=int(rpc("eth_blockNumber",[]),16)-20
start=head-int(days*86400*bps)
rows=[]; b=start
while b<=head:
    e=min(head,b+step-1)
    try: res=rpc("eth_getLogs",[{"address":addr,"topics":[T0],"fromBlock":hex(b),"toBlock":hex(e)}])
    except Exception as ex:
        print("shrink",b,ex,file=sys.stderr); step=max(200,step//2); continue
    for l in res:
        d=bytes.fromhex(l["data"][2:])
        rows.append([int(l["blockNumber"],16),int(l["transactionIndex"],16),int(l["logIndex"],16),int(l["blockTimestamp"],16),
                     str(s256(d[0:32])),str(s256(d[32:64])),str(int.from_bytes(d[64:96],'big')),str(int.from_bytes(d[96:128],'big')),s256(d[128:160])])
    b=e+1
    print(chain,b,len(rows),file=sys.stderr)
json.dump({"chain":chain,"pool":addr,"start":start,"head":head,"swaps":rows},gzip.open(f"data/swaps_{chain}_{int(days)}d.json.gz","wt"))
print("done",chain,start,head,len(rows))
