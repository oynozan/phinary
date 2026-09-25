import json, random, sys
from pyrevm import EVM, AccountInfo
from eth_abi import encode, decode
from eth_utils import function_signature_to_4byte_selector as sel
import mpmath as mp
mp.mp.dps=40
j=json.load(open('T.json'))
evm=EVM(); A="0x"+"11"*20; C="0x"+"22"*20
evm.insert_account_info(C, AccountInfo(code=bytes.fromhex(j['bin'])))
evm.insert_account_info(A, AccountInfo(balance=10**30))
def call(sig, types, args, rtypes):
    data=sel(sig)+encode(types,args)
    out=evm.message_call(caller=A,to=C,calldata=data,gas=30_000_000,is_static=True)
    return decode(rtypes, bytes(out))
cdf=lambda x: call("cdf(int256)",["int256"],[x],["int256"])[0]
hart=lambda x: call("hart(int256)",["int256"],[x],["int256"])[0]
WAD=10**18
print("solstat cdf on EVM:")
for x in [-10**8,-2,-1,0,1,2,10**8]: print(x, cdf(x))
# compare with draft emulation
sys.path.insert(0,'/Users/oynozan/Desktop/Dev/Web3/UniswapPrediction/docs/research/05-math-scripts')
import importlib.util
spec=importlib.util.spec_from_file_location("m2","/Users/oynozan/Desktop/Dev/Web3/UniswapPrediction/docs/research/05-math-scripts/02_cdf_fixedpoint.py")
import os; os.chdir('/Users/oynozan/Desktop/Dev/Web3/UniswapPrediction/docs/research/05-math-scripts')
m2=importlib.util.module_from_spec(spec); 
import contextlib, io
with contextlib.redirect_stdout(io.StringIO()): spec.loader.exec_module(m2)
random.seed(7); mism=0
for _ in range(3000):
    x=random.randint(-9*WAD,9*WAD)
    if cdf(x)!=m2.solstat_cdf(x): mism+=1
print("solstat emulation mismatches /3000:", mism)
mismE=0
for _ in range(3000):
    x=random.randint(-41*WAD,100*WAD)
    if call("expWad(int256)",["int256"],[x],["int256"])[0]!=m2.expWad(x): mismE+=1
mismL=0
for _ in range(3000):
    x=random.randint(1,10**30)
    if call("lnWad(int256)",["int256"],[x],["int256"])[0]!=m2.lnWad(x): mismL+=1
print("solady expWad mismatches",mismE,"lnWad mismatches",mismL)
# Hart port error and monotonicity on EVM
worst=0
for i in range(-9000,9001,3):
    x=i*10**15; e=abs(hart(x)-mp.ncdf(mp.mpf(x)/WAD)*WAD); worst=max(worst,e)
print("hart EVM max err (step 3e-3):", mp.nstr(worst/WAD,4))
print("hart sym:", max(abs(hart(x)+hart(-x)-WAD) for x in (random.randint(1,9*WAD) for _ in range(2000))))
# consecutive scans
tot=0;viol=0;md=0
for cstart in [0,1,10**9,3*10**17,7*10**17,1.3e18,2.5e18,4.9e18,7.07e18,7.0710678e18,8.5e18,-3e17,-2.5e18]:
    for step in (1,1000,10**6,10**9):
        v,d=call("scan(int256,int256,uint256)",["int256","int256","uint256"],[int(cstart),step,2000],["uint256","int256"])
        tot+=2000; viol+=v; md=max(md,d)
print("hart consecutive scans:",tot,"steps, violations",viol,"maxdrop",md)
# random close pairs
v2=0; md2=0
for _ in range(20000):
    x=random.randint(-9*WAD,9*WAD); y=x+random.randint(1,10**random.randint(0,14))
    a,b=hart(x),hart(y)
    if b<a: v2+=1; md2=max(md2,a-b)
print("hart random close pairs 20000: violations",v2,"maxdrop",md2)
# gas
for x in [0, 5*10**17, -2*10**18, 8*10**18]:
    print("gas hart",x,call("hartGas(int256)",["int256"],[x],["int256","uint256"])[1],"solstat",call("cdfGas(int256)",["int256"],[x],["int256","uint256"])[1],"lnWad",call("lnGas(int256)",["int256"],[x if x>0 else 3*10**18],["int256","uint256"])[1])
