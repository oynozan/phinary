# Fetch ThalesAMM BoughtFromAmm / SoldToAMM / SetImpliedVolatilityPerAsset logs from Optimism public RPC (10k-block chunks, threaded).
import json,urllib.request,time,sys
from concurrent.futures import ThreadPoolExecutor
URL='https://mainnet.optimism.io'; AMM='0x278B5A44397c9D8E52743fEdec263c4760dc1A1A'
TOP=['0xf3bfbc0822d1ed667a2b298e71e0304f2c1f4685398189d7c39e412f733150f4','0x1d6ff70c632edb1e6aba7fbc0148db68c8392e30f9dfaadae2543a2543757cf6','0x715e0a52c0b74c77d2d2012a363ac95b494302ad2abb78ac7406ec93451f1adb']
def one(b):
    body=json.dumps({"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"address":AMM,"fromBlock":hex(b),"toBlock":hex(b+9999),"topics":[TOP]}]}).encode()
    for i in range(30):
        try:
            r=json.load(urllib.request.urlopen(urllib.request.Request(URL,data=body,headers={'content-type':'application/json'}),timeout=60))
            if 'result' in r: return r['result']
            print('err',b,r.get('error'),file=sys.stderr)
        except Exception as e: print('exc',b,e,file=sys.stderr)
        time.sleep(3+5*i)
    raise RuntimeError(b)
a,z=int(sys.argv[1]),int(sys.argv[2])
blocks=list(range(a,z,10000)); out=[]
with ThreadPoolExecutor(int(sys.argv[4]) if len(sys.argv)>4 else 3) as ex:
    for i,res in enumerate(ex.map(one,blocks)):
        out+=res
        if i%200==0: print(i,len(blocks),len(out),file=sys.stderr,flush=True)
json.dump(out,open(sys.argv[3],'w'))
print('done',len(out),file=sys.stderr)
