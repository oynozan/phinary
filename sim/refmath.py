"""Real-number reference (mpmath, 50 significant digits) for the pricing math, plus DEFINITIONAL integer references for
the QuoteMath solvers (search-based, independent of the closed forms in sim/evm.py).

Conventions (docs/SPEC.md §0, §3.3): x = ln(S/K) as a WAD integer, varE36 = per-second variance * 1e36, tau/window in
seconds, n = samples in the settlement window (0 = continuous). All inputs are exact integers; the reference evaluates
the model exactly at those integers, so the measured error is purely the on-chain arithmetic.
"""
from fractions import Fraction

from mpmath import mp, mpf, ncdf, npdf, sqrt, betainc, gamma, pi, floor as mfloor, ceil as mceil, nint

mp.dps = 50

WAD = 10**18
E36 = 10**36
UNIT = 10**6
D = 2 * 10**24


def Phi(x):
    return ncdf(x)


def phi(x):
    return npdf(x)


def to_scale(v, scale=E36):
    """Nearest integer of v * scale."""
    return int(nint(v * scale))


# ------------------------------------------------------------------------------------------------ Asian binary
def asian_times(tau, window, n):
    """Exact (tDrift, tVar) in seconds as Fractions: mu = x - var/2 * tDrift, v = var * tVar."""
    if tau <= window:
        raise ValueError("TooLate")
    base = Fraction(tau - window)
    if n == 0:
        return base + Fraction(window, 2), base + Fraction(window, 3)
    return base + Fraction(window * (n - 1), 2 * n), base + Fraction(window * (n - 1) * (2 * n - 1), 6 * n * n)


def frac(f):
    return mpf(f.numerator) / f.denominator


def binary(x, var_e36, tau, window, n):
    """Exact model values at integer inputs: d, mid = Phi(d), pdf = phi(d), sqrt(v)."""
    t_drift, t_var = asian_times(tau, window, n)
    var = mpf(var_e36) / E36
    v = var * frac(t_var)
    mu = mpf(x) / WAD - var * frac(t_drift) / 2
    sv = sqrt(v)
    d = mu / sv
    return {"d": d, "mid": Phi(d), "pdf": phi(d), "sqrtV": sv, "tDrift": t_drift, "tVar": t_var}


def ask_bid(x, var_e36, tau, window, n, gamma_s, h0, kernel=0):
    """Spec §3.3 on exact reals with k = gammaS/sqrt(v) and the kernel's F, f: (F + k f, F - k f, spec ask, spec bid).
    The Gaussian ceil is capped at 1 as in NormalCdf.band; the Student-t side is not."""
    b = binary(x, var_e36, tau, window, n)
    k = (mpf(gamma_s) / WAD) / b["sqrtV"]
    if kernel == 0:
        F, f = b["mid"], b["pdf"]
    else:
        F, f = t_vm_cdf(5, b["d"]), t_vm_pdf(5, b["d"])
    gp = F + k * f
    gm = F - k * f
    up = int(mceil(gp * WAD))
    if kernel == 0:
        up = min(up, WAD)
    dn = max(int(mfloor(gm * WAD)), 0)
    return gp, gm, up + h0, max(dn - h0, 0)


# ------------------------------------------------------------------------------------------------ Student-t (nu = 5)
def t_cdf(nu, t):
    """Student-t CDF via the regularized incomplete beta (independent of the closed forms under test)."""
    t = mpf(t)
    if t == 0:
        return mpf(1) / 2
    tl = betainc(mpf(nu) / 2, mpf(1) / 2, 0, nu / (nu + t * t), regularized=True) / 2
    return 1 - tl if t > 0 else tl


def t_vm_cdf(nu, d):
    """Variance-matched Student-t: F(d) = T_nu(d * sqrt(nu/(nu-2)))."""
    return t_cdf(nu, mpf(d) * sqrt(mpf(nu) / (nu - 2)))


def t_vm_pdf(nu, d):
    c = sqrt(mpf(nu) / (nu - 2))
    t = mpf(d) * c
    return c * gamma(mpf(nu + 1) / 2) / (sqrt(nu * pi) * gamma(mpf(nu) / 2)) * (1 + t * t / nu) ** (-mpf(nu + 1) / 2)


# ------------------------------------------------------------------------------------------------ QuoteMath (definitions)
def N_buy(lam, a, i0, q):
    """Exact cost numerator of q units: integral of the marginal ask a + lam*x/1e6 over [i0, i0+q], times D."""
    return lam * q * q + (2 * UNIT * a + 2 * lam * i0) * q


def M_sell(lam, b, i0, q):
    """Exact proceeds numerator of selling q units from i0 at marginal bid b + lam*x/1e6 over [i0-q, i0], times D."""
    return -lam * q * q + (2 * UNIT * b + 2 * lam * i0) * q


def cdiv(a, b):
    return -((-a) // b)


def def_buy_exact_out(lam, a, i0, q):
    return cdiv(N_buy(lam, a, i0, q), D)


def def_sell_exact_in(lam, b, i0, q):
    return M_sell(lam, b, i0, q) // D


def def_buy_exact_in(lam, a, i0, amt):
    """max q >= 0 with ceil(N(q)/D) <= amt, by exponential + binary search (N is increasing for beta > 0)."""
    lo, hi = 0, 1
    while def_buy_exact_out(lam, a, i0, hi) <= amt:
        lo, hi = hi, hi * 2
    while hi - lo > 1:
        m = (lo + hi) // 2
        if def_buy_exact_out(lam, a, i0, m) <= amt:
            lo = m
        else:
            hi = m
    return lo


def def_sell_exact_out(lam, b, i0, amt):
    """min q >= 0 on the increasing branch (2 lam q <= beta) with floor(M(q)/D) >= amt, or None if unreachable there."""
    if amt == 0:
        return 0
    if lam == 0:
        hi = 1
        while def_sell_exact_in(lam, b, i0, hi) < amt:
            hi *= 2
    else:
        hi = (2 * UNIT * b + 2 * lam * i0) // (2 * lam)
        if def_sell_exact_in(lam, b, i0, hi) < amt:
            return None
    lo = 0
    while hi - lo > 1:
        m = (lo + hi) // 2
        if def_sell_exact_in(lam, b, i0, m) >= amt:
            hi = m
        else:
            lo = m
    return hi
