import sys, json
from rpcx import rpc
T="0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438"
def pad(a): return "0x"+a[2:].lower().rjust(64,'0')
chain, url, pm, start, step, usdc, weth = sys.argv[1:8]
start=int(start); step=int(step)
head=int(rpc(url,"eth_blockNumber",[]),16)
c0c1=[("0x"+"0"*40, usdc)]
a,b=sorted([usdc.lower(),weth.lower()]); c0c1.append((a,b))
out=[]
for c0,c1 in c0c1:
    b0=start
    while b0<=head:
        e=min(head,b0+step-1)
        logs=rpc(url,"eth_getLogs",[{"address":pm,"topics":[T,None,pad(c0),pad(c1)],"fromBlock":hex(b0),"toBlock":hex(e)}],tries=6)
        for l in logs:
            d=bytes.fromhex(l["data"][2:])
            w=[int.from_bytes(d[32*i:32*i+32],'big') for i in range(5)]
            def s24(x): x&=(1<<24)-1; return x-(1<<24) if x>=1<<23 else x
            out.append(dict(chain=chain,block=int(l["blockNumber"],16),id=l["topics"][1],c0=c0,c1=c1,fee=w[0],ts=s24(w[1]),hooks="0x"+hex(w[2])[2:].rjust(40,'0'),tick=s24(w[4])))
        b0=e+1
    print(chain,c0,c1,"done",file=sys.stderr)
json.dump(out,open(f"init_{chain}.json","w"),indent=1)
print(chain,len(out),"pools;",sum(1 for o in out if int(o['hooks'],16)!=0),"hooked")
