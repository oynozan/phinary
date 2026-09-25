import json,subprocess,itertools,time
sw=json.load(open('../../v3_swaps.json'))
blocks=sorted(set(s[0] for s in sw['swaps']))
print(len(blocks),'blocks with swaps')
RS=["https://ethereum-rpc.publicnode.com","https://eth.drpc.org","https://eth-mainnet.public.blastapi.io","https://mainnet.gateway.tenderly.co"]
out={}
todo=blocks[:]
B=50; ri=0
while todo:
    chunk=todo[:B]
    req=[{"jsonrpc":"2.0","id":i,"method":"eth_getBlockByNumber","params":[hex(b),False]} for i,b in enumerate(chunk)]
    R=RS[ri%len(RS)]; ri+=1
    try:
        o=subprocess.run(["curl","-s","--max-time","60","-X","POST",R,"-H","Content-Type: application/json","-d",json.dumps(req)],capture_output=True,text=True).stdout
        j=json.loads(o)
        got=0
        for x in j:
            if 'result' in x and x['result']:
                out[chunk[x['id']]]=int(x['result']['timestamp'],16); got+=1
        todo=[b for b in todo if b not in out]
        if got==0: time.sleep(1)
    except Exception as e:
        time.sleep(1)
    if ri%50==0: print(len(out),len(todo),flush=True)
json.dump(out,open('v3_blockts.json','w')); print('done',len(out))
