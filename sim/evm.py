"""Bit-exact integer emulation of src/math/*.sol (EVM semantics: checked uint256/int256, Solidity signed division
truncates toward zero, >> on signed ints floors).

This is the integer SPEC the Solidity must reproduce bit for bit (test/math/*: *Bits vectors), and the trusted base of
the formal/ certificates (they import their constants and expWad from here).
"""
from math import isqrt

WAD = 10**18
E36 = 10**36
U256_MAX = (1 << 256) - 1
I256_MAX = (1 << 255) - 1
I256_MIN = -(1 << 255)


class Revert(Exception):
    def __init__(self, name):
        super().__init__(name)
        self.name = name


def u(v):
    if v < 0 or v > U256_MAX:
        raise Revert("Panic(0x11)")
    return v


def i(v):
    if v < I256_MIN or v > I256_MAX:
        raise Revert("Panic(0x11)")
    return v


def sdiv(a, b):
    """Solidity int256 division: truncation toward zero."""
    if b == 0:
        raise Revert("Panic(0x12)")
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


def ceil_div(a, b):
    return -((-a) // b)


# ------------------------------------------------------------------------------------------------ solady FixedPointMathLib
def exp_wad(x):
    if x <= -41446531673892822313:
        return 0
    if x >= 135305999368893231589:
        raise Revert("ExpOverflow")
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
    return (r * 3822833074963236453042738258902158003155416615667) >> (195 - k)


def exp_wad_internals(x):
    """(k, reduced x, p, q, r) of expWad for x in its non-zero negative domain (used by the formal certificate)."""
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
    return k, x, p, q, sdiv(p, q)


def sqrt(x):
    return isqrt(x)


def full_mul_div(a, b, d):
    if d == 0:
        raise Revert("FullMulDivFailed")
    r = a * b // d
    if r > U256_MAX:
        raise Revert("FullMulDivFailed")
    return r


def full_mul_div_up(a, b, d):
    if d == 0:
        raise Revert("FullMulDivFailed")
    r = ceil_div(a * b, d)
    if r > U256_MAX:
        raise Revert("FullMulDivFailed")
    return r


def div_up(a, d):
    if d == 0:
        raise Revert("DivFailed")
    return ceil_div(a, d)


# ------------------------------------------------------------------------------------------------ NormalCdf (HartX36)
NUM36 = [
    35262496599891100000000000000000000,
    700383064443688000000000000000000000,
    6373962203531650000000000000000000000,
    33912866078383000000000000000000000000,
    112079291497871000000000000000000000000,
    221213596169931000000000000000000000000,
    220206867912376000000000000000000000000,
]
DEN36 = [
    88388347648318400000000000000000000,
    1755667163182640000000000000000000000,
    16064177579207000000000000000000000000,
    86780732202946100000000000000000000000,
    296564248779674000000000000000000000000,
    637333633378831000000000000000000000000,
    793826512519948000000000000000000000000,
    440413735824752000000000000000000000000,
]
SPLIT = 7071067811865470000
SQRT_2PI_WAD = 2506628274631000502
SATURATE = 37 * WAD
KAPPA_SCALE = 10**27
KAPPA_MAX = 10**34


def horner(coeffs, z):
    h = coeffs[0]
    for c in coeffs[1:]:
        h = sdiv(h * z, WAD) + c
    return h


def num36(z):
    return horner(NUM36, z)


def den36(z):
    return horner(DEN36, z)


def cf(z):
    return z + WAD * WAD // (z + 2 * WAD * WAD // (z + 3 * WAD * WAD // (z + 4 * WAD * WAD // (z + 65 * WAD // 100))))


def e_of(z):
    return exp_wad(-(z * z // WAD // 2))


def parts(z):
    """(e, a, b) with tail(z) = floor(e * a / b) before the 1/2 clamp; R = a/b."""
    e = e_of(z)
    if z < SPLIT:
        return e, num36(z), den36(z)
    return e, WAD, cf(z) * SQRT_2PI_WAD // WAD


def tail(z):
    if z < 0:
        z = 0
    if z > SATURATE:
        return 0
    e, a, b = parts(z)
    c = e * a // b
    return min(c, WAD // 2)


def cdf(x):
    if x <= 0:
        if x < -SATURATE:
            return 0
        return tail(-x)
    if x > SATURATE:
        return WAD
    return WAD - tail(x)


def pdf(x):
    if x > SATURATE or x < -SATURATE:
        return 0
    return exp_wad(-(x * x // WAD // 2)) * WAD // SQRT_2PI_WAD


def band(x, kappa):
    """NormalCdf.band: (min(1, ceil(Phi + k phi)), max(0, floor(Phi - k phi))), one rounding each, kappa = k/sqrt(2pi) * 1e27."""
    if kappa > KAPPA_MAX:
        return WAD, 0
    if x > SATURATE:
        return WAD, WAD
    if x < -SATURATE:
        return 0, 0
    z = -x if x < 0 else x
    e, a, b = parts(z)
    p = a * KAPPA_SCALE
    q = kappa * b
    den = b * KAPPA_SCALE
    u(p + q)
    plus_up = full_mul_div_up(e, p + q, den)
    minus_dn = full_mul_div(e, p - q, den) if p >= q else -full_mul_div_up(e, q - p, den)
    if x > 0:
        up = WAD if minus_dn <= 0 else WAD - minus_dn
        dn = 0 if plus_up >= WAD else WAD - plus_up
    else:
        up = WAD if plus_up > WAD else plus_up
        dn = 0 if minus_dn <= 0 else minus_dn
    return up, dn


# ------------------------------------------------------------------------------------------------ BinaryPricer
def effective_times(tau, window, n):
    if tau <= window:
        raise Revert("TooLate")
    base = (tau - window) * WAD
    if n == 0:
        return base + window * WAD // 2, base + window * WAD // 3
    return base + window * WAD * (n - 1) // (2 * n), base + full_mul_div(window * WAD, (n - 1) * (2 * n - 1), 6 * n * n)


def moments(x, var_e36, tau, window, n):
    """(d, sqrtV) exactly as BinaryPricer._moments."""
    t_drift, t_var = effective_times(tau, window, n)
    sqrt_v = isqrt(full_mul_div(var_e36, t_var, WAD))
    if sqrt_v == 0:
        raise Revert("ZeroVariance")
    mu = i(x - i(full_mul_div(var_e36, t_drift, 2 * E36)))
    d = sdiv(i(mu * WAD), sqrt_v)
    return d, sqrt_v


def price(x, var_e36, tau, window, n):
    """(d, sqrtV, mid, pdf) of BinaryPricer.price."""
    d, sqrt_v = moments(x, var_e36, tau, window, n)
    return d, sqrt_v, cdf(d), pdf(d)


def ask_bid_outward(mid, pdf_, sqrt_v, gamma_s, h0):
    """mid +/- k*pdf, each side rounded outward: askBid's branch for kernel != 0."""
    g_up = full_mul_div_up(gamma_s, pdf_, sqrt_v)
    g_dn = full_mul_div(gamma_s, pdf_, sqrt_v)
    ask = mid + g_up + h0
    sub = g_dn + h0
    return ask, (mid - sub if mid > sub else 0)


GAMMA_MAX = 10**30


def kappa_of(gamma_s, sqrt_v):
    if gamma_s > GAMMA_MAX:
        return U256_MAX
    return div_up(div_up(gamma_s * 10**45, sqrt_v), SQRT_2PI_WAD)


def ask_bid(d, sqrt_v, mid, pdf_, kernel, gamma_s, h0):
    """BinaryPricer.askBid on a Result (d, sqrtV, mid, pdf, kernel)."""
    if kernel != 0:
        return ask_bid_outward(mid, pdf_, sqrt_v, gamma_s, h0)
    up, dn = band(d, kappa_of(gamma_s, sqrt_v))
    return up + h0, (dn - h0 if dn > h0 else 0)


# ------------------------------------------------------------------------------------------------ QuoteMath
UNIT = 10**6
D = 2 * 10**24


MAX_AMOUNT = 10**24
MAX_LAM = 10**24
MAX_PRICE = 10**30
MAX_BETA = 10**38


def beta(price_, lam, i0):
    if price_ > MAX_PRICE or lam > MAX_LAM or abs(i0) > MAX_AMOUNT:
        raise Revert("Band")
    b = i(i(u(2 * UNIT * price_)) + i(i(2 * i(lam)) * i0))
    if b <= 0 or b > MAX_BETA:
        raise Revert("Band")
    return b


def _beta(price_, lam, i0, amt):
    if amt > MAX_AMOUNT:
        raise Revert("Band")
    return beta(price_, lam, i0)


def buy_exact_out(a, lam, i0, q):
    b = _beta(a, lam, i0, q)
    return div_up(u(u(u(lam * q) * q) + u(b * q)), D)


def buy_exact_in(a, lam, i0, amt_in):
    b = _beta(a, lam, i0, amt_in)
    r = u(amt_in * D)
    if lam == 0:
        return r // b
    return (isqrt(u(u(b * b) + u(u(4 * lam) * r))) - b) // (2 * lam)


def sell_exact_in(b_price, lam, i0, q):
    b = _beta(b_price, lam, i0, q)
    if u(u(2 * lam) * q) > b:
        raise Revert("Band")
    return (u(b * q) - u(u(lam * q) * q)) // D


def sell_exact_out(b_price, lam, i0, amt_out):
    b = _beta(b_price, lam, i0, amt_out)
    r = u(amt_out * D)
    if lam == 0:
        return div_up(r, b)
    bb = u(b * b)
    f = u(u(4 * lam) * r)
    if f > bb:
        raise Revert("Unreachable")
    q = div_up(b - isqrt(bb - f), 2 * lam)
    if u(u(2 * lam) * q) > b:
        raise Revert("Band")
    return q


# ------------------------------------------------------------------------------------------------ StudentTCdf (nu = 5)
SQRT3_36 = 1732050807568877293527446341505872367
PI_2_36 = 1570796326794896619231321691639751442
PI_6_36 = 523598775598298873077107230546583814
TAN15_36 = 267949192431122706472553658494127633
INV_PI_36 = 318309886183790671537767526745028724
F5PDF_36 = 13231893490123009188271835959511266594
DSAT5 = 5_500 * WAD
DSAT_PDF = 10**24
ATAN_C = [
    34482758620689655172413793103448276,
    -37037037037037037037037037037037037,
    40000000000000000000000000000000000,
    -43478260869565217391304347826086957,
    47619047619047619047619047619047619,
    -52631578947368421052631578947368421,
    58823529411764705882352941176470588,
    -66666666666666666666666666666666667,
    76923076923076923076923076923076923,
    -90909090909090909090909090909090909,
    111111111111111111111111111111111111,
    -142857142857142857142857142857142857,
    200000000000000000000000000000000000,
    -333333333333333333333333333333333333,
    E36,
]


def _abs(d):
    return -d if d < 0 else d


def _half(d, g):
    return WAD // 2 - g if d < 0 else WAD // 2 + g


def atan36(a):
    inv = a > E36
    b = E36 * E36 // a if inv else a
    off = 0
    if b > TAN15_36:
        off = PI_6_36
        c = sdiv((b * SQRT3_36 // E36 - E36) * E36, b + SQRT3_36)
    else:
        c = b
    z = sdiv(c * c, E36)
    p = ATAN_C[0]
    for coef in ATAN_C[1:]:
        p = coef + sdiv(p * z, E36)
    theta = off + sdiv(c * p, E36)
    if inv:
        theta = PI_2_36 - theta
    return theta


def cdf5(d):
    ud = _abs(d)
    if ud >= DSAT5:
        return 0 if d < 0 else WAD
    a = full_mul_div(ud, 10**54, SQRT3_36)
    theta = atan36(a)
    y = ud * ud + 3 * E36
    t1 = full_mul_div(ud * WAD, y + 2 * E36, y)
    t2 = full_mul_div(t1, E36, y)
    h = t2 * SQRT3_36 // E36
    g = full_mul_div(theta + h, INV_PI_36, 10**54)
    return _half(d, g)


def pdf5(d):
    ud = _abs(d)
    if ud >= DSAT_PDF:
        return 0
    y = ud * ud + 3 * E36
    q = E36 * E36 // y
    q3 = (q * q // E36) * q // E36
    return full_mul_div(q3, F5PDF_36, 10**54)


def price_kernel(x, var_e36, tau, window, n, kernel):
    if kernel == 0:
        return price(x, var_e36, tau, window, n)
    if kernel != 1:
        raise Revert("UnknownKernel")
    d, sqrt_v = moments(x, var_e36, tau, window, n)
    return d, sqrt_v, cdf5(d), pdf5(d)
