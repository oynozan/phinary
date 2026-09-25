import json, random
from pyrevm import EVM, AccountInfo
from eth_abi import encode, decode
from eth_utils import function_signature_to_4byte_selector as sel
import mpmath as mp
mp.mp.dps=40
j=json.load(open('T.json')); evm=EVM(); A="0x"+"11"*20; C="0x"+"22"*20
evm.insert_account_info(C, AccountInfo(code=bytes.fromhex(j['bin'])))
def call(sig, types, args, rtypes):
    out=evm.message_call(caller=A,to=C,calldata=sel(sig)+encode(types,args),gas=30_000_000,is_static=True)
    return decode(rtypes, bytes(out))
WAD=10**18
random.seed(3)
print("hartU==hart on 3000:", all(call("hartU(int256)",["int256"],[x],["int256"])[0]==call("hart(int256)",["int256"],[x],["int256"])[0] for x in (random.randint(-9*WAD,9*WAD) for _ in range(3000))))
for x in [0,5*10**17,-2*10**18,8*10**18]: print("gas hartU",x,call("hartUGas(int256)",["int256"],[x],["int256","uint256"])[1])
worst=0
for _ in range(3000):
    S=random.uniform(1000,10000); K=S*mp.e**random.uniform(-0.5,0.5); sg=random.uniform(0.2,2); tau=random.uniform(60,365*86400)/(365*86400)
    r,g=call("quoteGas(uint256,uint256,uint256,uint256)",["uint256"]*4,[int(S*WAD),int(K*WAD),int(sg*WAD),int(tau*WAD)],["int256","uint256"])
    Sm,Km,sm,tm=[mp.mpf(int(v*WAD))/WAD for v in (S,K,sg,tau)]
    ex=mp.ncdf((mp.log(Sm/Km)-sm**2*tm/2)/(sm*mp.sqrt(tm)))
    worst=max(worst,abs(r/WAD-ex))
print("quote pipeline (solady ln/sqrt + hartU) max |P-P_ref| over 3000:", mp.nstr(worst,4), "last gas", g)
