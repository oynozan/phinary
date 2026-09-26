"""Emit Foundry differential-test vectors from the Python reference quote function (the one the backtest uses).
All on-chain inputs are integers: sqrtPriceX96 (uint160), strike as ln-price in WAD, sigma WAD (annualised), tau seconds.
Expected outputs are WAD (1e18) with a stated absolute tolerance; the Solidity test reads them with vm.readFile + vm.parseJson."""
import json, numpy as np, mpmath as mp, lib, bt
mp.mp.dps = 40
rng = np.random.default_rng(42)
WAD = 10**18
def sqrtpx96_from_price(p_eth_usdc, dec0=6, dec1=18):
    # token0 = USDC (6), token1 = WETH (18) as on mainnet 0x88e6..; raw price = token1/token0 = 1e12/P
    raw = mp.mpf(10)**(dec1-dec0)/mp.mpf(p_eth_usdc)
    return int(mp.sqrt(raw)*mp.mpf(2)**96)
vecs = []
A = bt.A
idx = rng.integers(lib.minute_of('2024-01-01'), lib.N - 20000, size=200)
for t in idx:
    S = float(np.exp(A['pool'][t])); sig = float(np.clip(A['ewma1440'][t], 0.3, 2.0))
    for tau_min in (60, 240, 1440, 10080):
        for k in (-1.0, 0.0, 0.5):
            lnK = np.log(S) + k*sig*np.sqrt(tau_min/lib.MPY)
            sp = sqrtpx96_from_price(S)
            # reference: recompute S from the integer sqrtPriceX96 exactly as the contract must
            Sx = mp.mpf(10)**12/((mp.mpf(sp)/mp.mpf(2)**96)**2)
            sd = mp.mpf(sig)*mp.sqrt(mp.mpf(tau_min)/lib.MPY)
            d2 = (mp.log(Sx) - mp.mpf(lnK) - sd*sd/2)/sd
            mid = mp.ncdf(d2)
            hD = mp.npdf(d2)/sd*mp.mpf('0.0005')         # delta-scaled half-spread term, gamma = 5 bp, c_delta = 1
            s = mp.mpf('0.01')
            vecs.append(dict(block=int(t), sqrtPriceX96=str(sp), lnStrikeWad=str(int(mp.mpf(lnK)*WAD)), sigmaWad=str(int(mp.mpf(sig)*WAD)),
                             tauSeconds=tau_min*60, midWad=str(int(mid*WAD)), askMarginalWad=str(int(min(mid+s+hD, 1)*WAD)),
                             bidMarginalWad=str(int(max(mid-s-hD, 0)*WAD)), tolWad=str(10**6)))
json.dump(dict(version=1, generator='econ/export_vectors.py', kernel='normal', r=0, note='mid = N(d2), d2=(ln S - ln K - sd^2/2)/sd, sd=sigma*sqrt(tau/525600 min)', vectors=vecs), open('out/quote_vectors.json', 'w'), indent=0)
print(len(vecs), 'vectors written to out/quote_vectors.json')
