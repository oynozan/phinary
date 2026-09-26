"""Arbitrum block headers (timestamp, l1BlockNumber, #tx) for every swap block, plus a contiguous 12,000-block sample.
The public arb1 RPC returns blockTimestamp = 0 in ~72% of eth_getLogs rows, so headers are fetched directly, sharded
over several public endpoints. Log rows with a non-zero blockTimestamp are used as-is."""
import json,gzip,subprocess,time,sys,os,threading
from concurrent.futures import ThreadPoolExecutor
URLS=["https://arbitrum.meowrpc.com","https://arbitrum-one.public.blastapi.io","https://arbitrum-one-public.nodies.app",
      "https://arb-pokt.nodies.app","https://arbitrum-one.publicnode.com","https://api.zan.top/arb-one","https://arbitrum.drpc.org","https://arb1.arbitrum.io/rpc"]
def batch(nums,k0):
    body=json.dumps([{"jsonrpc":"2.0","id":i,"method":"eth_getBlockByNumber","params":[hex(n),False]} for i,n in enumerate(nums)])
    o=""
    for k in range(40):
        U=URLS[(k0+k)%len(URLS)]
        o=subprocess.run(["curl","-s","--max-time","60","-X","POST",U,"-H","Content-Type: application/json","-d",body],capture_output=True,text=True).stdout
        try:
            j=json.loads(o)
            if isinstance(j,list) and len(j)==len(nums) and all(x.get('result') for x in j):
                j.sort(key=lambda x:x['id'])
                return [(int(x['result']['number'],16),int(x['result']['timestamp'],16),int(x['result'].get('l1BlockNumber','0x0'),16),len(x['result']['transactions']),int(x['result']['gasUsed'],16),int(x['result'].get('baseFeePerGas','0x0'),16)) for x in j]
        except Exception: pass
        time.sleep(min(20,1+k))
    raise Exception("batch fail "+o[:300])
d=json.load(gzip.open("data/swaps_arb.json.gz","rt"))
blocks=sorted(set(r[0] for r in d["swaps"]))
known={r[0]:r[3] for r in d["swaps"] if r[3]>0}
P="data/arb_blocks_partial.json"
out=json.load(open(P)) if os.path.exists(P) else {}
todo=[b for b in blocks if str(b) not in out and b not in known]
print("todo",len(todo),file=sys.stderr)
chunks=[todo[i:i+20] for i in range(0,len(todo),20)]
lock=threading.Lock(); done=[0]
def work(ic):
    i,c=ic; r=batch(c,i)
    with lock:
        for x in r: out[str(x[0])]=x
        done[0]+=1
        if done[0]%100==0: print(done[0],len(chunks),file=sys.stderr); json.dump(out,open(P,"w"))
with ThreadPoolExecutor(len(URLS)) as ex: list(ex.map(work,enumerate(chunks)))
for b,t in known.items(): out.setdefault(str(b),[b,t,0,-1,-1,-1])
json.dump(out,open(P,"w"))
h=d["head"]; cc=[list(range(s,s+20)) for s in range(h-12000,h,20)]; cont=[]
with ThreadPoolExecutor(len(URLS)) as ex:
    for r in ex.map(lambda ic: batch(ic[1],ic[0]), enumerate(cc)): cont+=r
json.dump({"swapblocks":out,"contig":cont},gzip.open("data/arb_blocks.json.gz","wt")); print("done",len(out),len(cont))
