# Independent re-computation of the prototype's delta table (report §8).
WAD=10**18
def cdiv(a,b): return -(-a//b)
P=40*10**16; s=10**16
q_ = {True:(P+s,P-s), False:(WAD-P+s, WAD-P-s)}   # (ask,bid) YES / NO
def bsd(spec,unspec): return ((spec & (2**128-1))<<128) | (unspec & (2**128-1))
rows=[("1",True,True,True,200),("2",True,True,False,250),("3",True,False,True,250),("4",True,False,False,100),
      ("5",True,True,False,250),("6",True,True,True,300),("7",False,True,True,200),("8",False,True,False,250),
      ("9",False,False,True,250),("10",False,False,False,100),("11",False,True,True,100)]
for outcome0 in (True,False):
    inv={True:0,False:0}; out={True:0,False:0}; bucket=1_000_000*10**6
    print("outcome is currency0" if outcome0 else "outcome is currency1")
    for lab,y,buy,ei,amt in rows:
        a=amt*10**6; ask,bid=q_[y]
        if buy:
            if ei: cash,q=a,a*WAD//ask
            else: q,cash=a,cdiv(a*ask,WAD)
        else:
            if ei: q,cash=a,a*bid//WAD
            else: cash,q=a,cdiv(a*WAD,bid)
        if buy:
            fi=min(inv[y],q); mint=q-fi; inv[y]-=fi; out[y]+=q; bucket+=cash
        else:
            fi=mint=0; inv[y]+=q; out[y]-=q; bucket-=cash
        unspec = (q if ei else cash) if buy else (cash if ei else q)
        spec,uns = (a,-unspec) if ei else (-a,unspec)
        # hookDelta mapping (Hooks.sol afterSwap): specified is currency0 iff (amountSpecified<0)==zeroForOne
        usdc0 = not outcome0
        zf1 = usdc0 if buy else (not usdc0)
        amountSpecified = -a if ei else a
        spec_is0 = ((amountSpecified<0)==zf1)
        hd = (spec,uns) if spec_is0 else (uns,spec)
        caller = (-hd[0],-hd[1])
        assert max(out.values())<=bucket
        print(f"{lab:>3} zf1={'T' if zf1 else 'F'} amtSpec={amountSpecified} q={q} usdc={cash} BSD=0x{bsd(spec,uns):064x} hookDelta={hd} caller={caller} fromInv={fi} minted={mint}")
    print("end bucket",bucket,"inv",inv,"out",out)
