from Crypto.Hash import keccak
def k(s):
    h=keccak.new(digest_bits=256); h.update(s.encode()); return '0x'+h.hexdigest()
for s in ["BoughtFromAmm(address,address,uint8,uint256,uint256,address,address)","SoldToAMM(address,address,uint8,uint256,uint256,address,address)","BoughtWithDiscount(address,uint256,uint256)","BoughtOptionType(address,uint256,bool)","ReferrerPaid(address,address,uint256,uint256)","SetImpliedVolatilityPerAsset(bytes32,uint256)","getOracleDetails()","times()","result()","tradingMarketsPerRound(uint256,uint256)","oraclePrice()","resolved()","finalPrice()","phase()"]:
    print(s,k(s))
