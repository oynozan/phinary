# expWad/sdiv copied verbatim from docs/research/05-math-scripts/02_cdf_fixedpoint.py (bit-exact vs solady on revm)
M256 = (1 << 256) - 1


def wrap(v):  # int256 two's complement wrap (EVM semantics in unchecked/assembly)
    v &= M256
    return v - (1 << 256) if v >> 255 else v


def sdiv(a, b):
    if b == 0:
        return 0
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


# ---------------- solady / solmate expWad ----------------
def _expWad(x, solmate=True):
    if x <= (-42139678854452767551 if solmate else -41446531673892822313):
        return 0
    if x >= 135305999368893231589:
        raise OverflowError
    x = sdiv(x << 78, 5**18)
    k = (sdiv(x << 96, 54916777467707473351141471128) + 2**95) >> 96
    x = x - k * 54916777467707473351141471128
    y = x + 1346386616545796478920950773328
    y = ((y * x) >> 96) + 57155421227552351082224309758442
    p = y + x - 94201549194550492254356042504812
    p = ((p * y) >> 96) + 28719021644029726153956944680412240
    p = p * x + (4385272521454847904659076985693276 << 96)
    q = x - 2855989394907223263936484059900
    q = ((q * x) >> 96) + 50020603652535783019961831881945
    q = ((q * x) >> 96) - 533845033583426703283633433725380
    q = ((q * x) >> 96) + 3604857256930695427073651918091429
    q = ((q * x) >> 96) - 14423608567350463180887372962807573
    q = ((q * x) >> 96) + 26449188498355588339934803723976023
    r = sdiv(p, q)
    r = (r * 3822833074963236453042738258902158003155416615667) >> (195 - k)
    return r


WAD=10**18
def expWad(x): return _expWad(x, solmate=False)   # solady cutoff, as T.sol uses solady
NC=[35262496599891100,700383064443688000,6373962203531650000,33912866078383000000,112079291497871000000,221213596169931000000,220206867912376000000]
DC=[88388347648318400,1755667163182640000,16064177579207000000,86780732202946100000,296564248779674000000,637333633378831000000,793826512519948000000,440413735824752000000]
SPLIT=7071067811865470000
def parts(z):
    """returns (E, Nn, Dd) for z < SPLIT, exactly as T.sol::tail"""
    e=expWad(-(z*z//WAD//2))
    n=NC[0]
    for c in NC[1:]: n=n*z//WAD+c
    d=DC[0]
    for c in DC[1:]: d=d*z//WAD+c
    return e,n,d
def tail(z):
    if z>37*WAD: return 0
    if z<SPLIT:
        e,n,d=parts(z); c=e*n//d
    else:
        f=z+WAD*WAD//(z+2*WAD*WAD//(z+3*WAD*WAD//(z+4*WAD*WAD//(z+65*WAD//100))))
        e=expWad(-(z*z//WAD//2)); c=e*WAD//(f*2506628274631000502//WAD)
    return min(c,WAD//2)

# ---- variant X36: Horner accumulators carry 18 extra decimals (coefficients * 1e18), then c = e*n/d.
NC36=[c*10**18 for c in NC]; DC36=[c*10**18 for c in DC]
def parts36(z):
    e=expWad(-(z*z//WAD//2))
    n=NC36[0]
    for c in NC36[1:]: n=n*z//WAD+c
    d=DC36[0]
    for c in DC36[1:]: d=d*z//WAD+c
    return e,n,d
def tail36(z, zcut=SPLIT):
    """lower-branch Hart with 36-decimal accumulators; returns 0 for z >= zcut (monotone cut)."""
    if z >= zcut: return 0
    e,n,d=parts36(z); return min(e*n//d, WAD//2)
def cf_tail(z):
    f=z+WAD*WAD//(z+2*WAD*WAD//(z+3*WAD*WAD//(z+4*WAD*WAD//(z+65*WAD//100))))
    e=expWad(-(z*z//WAD//2)); return min(e*WAD//(f*2506628274631000502//WAD), WAD//2)
