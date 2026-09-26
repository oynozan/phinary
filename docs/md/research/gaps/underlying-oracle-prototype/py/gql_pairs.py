from ugql import gql
import json,sys
chains={'ETHEREUM':('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'),
 'BASE':('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913','0x4200000000000000000000000000000000000006'),
 'ARBITRUM':('0xaf88d065e77c8cc2239327c5edb3a432268e5831','0x82af49447d8a07e3bd95bd0d56f35241523fbab1'),
 'UNICHAIN':('0x078d782b760474a361dda0af3839290b0ef57ad6','0x4200000000000000000000000000000000000006')}
res={}
for ch,(usdc,weth) in chains.items():
    allp=[]; cur=None
    for page in range(60):
        c=f", tvlCursor: {cur}" if cur is not None else ""
        r=gql(f'query {{ topV4Pools(chain: {ch}, first: 100, tokenFilter: "{usdc}"{c}) {{ poolId feeTier tickSpacing totalLiquidity {{ value }} cumulativeVolume(duration: DAY) {{ value }} hook {{ address }} token0 {{ symbol address }} token1 {{ symbol address }} }} }}')
        if 'data' not in r or not r['data'] or not r['data']['topV4Pools']:
            if 'data' not in r: print(ch,'err',r,file=sys.stderr)
            break
        ps=r['data']['topV4Pools']; allp+=ps
        nc=ps[-1]['totalLiquidity']['value']
        if len(ps)<100 or nc==cur: break
        cur=nc
    eth=[p for p in allp if {(p['token0']['address'] or '0x0').lower(),(p['token1']['address'] or '0x0').lower()} & {weth,'0x0000000000000000000000000000000000000000'} or p['token0']['symbol'] in('ETH','WETH')]
    res[ch]=eth
    print(ch,'usdc pools',len(allp),'eth/usdc',len(eth),file=sys.stderr)
json.dump(res,open('gql_ethusdc.json','w'),indent=1)
