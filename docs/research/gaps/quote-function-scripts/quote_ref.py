"""
Integer-exact reference model of the PredictionHook quote function (spec in
../quote-function-spot-input-and-size-impact.md, section 2).

Everything that the Solidity hook computes in integers is computed here in Python ints
(exact, arbitrary precision).  The only real-valued step is Phi / phi of d2, which is
evaluated with mpmath at 50 digits and then rounded in the direction the spec prescribes
(ceil for ask-side quantities, floor for bid-side quantities).  The on-chain Hart CDF is a
separate, already-tested component (05 section 2, 03 section 3.9); this file specifies what
is done with its output.

Units
  token amounts  : int, 6 decimals (1 YES = 1 NO = 1 USDC = 10**6 units)
  prices         : int WAD (10**18 == 1 USDC per whole token)
  log prices     : int WAD (natural log)
  Lam            : int, WAD of marginal price per 1 whole token of net flow (impact slope)
  I              : int, signed net YES-equivalent the vault has SOLD in the current epoch (units)
                   (+ for YES buys and NO sells, - for YES sells and NO buys)
"""
from dataclasses import dataclass, field
from math import isqrt
from mpmath import mp, mpf, ncdf, npdf, sqrt as msqrt, erfinv, ceil as mceil, floor as mfloor

mp.dps = 50
WAD = 10**18
UNIT = 10**6
D = 2 * UNIT * WAD          # common denominator of all amount numerators
YEAR = 365 * 86400


class Halt(Exception):
    pass


def ceil_div(a, b):
    assert b > 0
    return -((-a) // b)


@dataclass
class Params:
    lnK: int                  # WAD, log strike in the same orientation as x
    expiry: int               # unix seconds
    sigma2: int               # annualised variance, WAD (0.6**2 -> 0.36e18)
    p_min: int                # WAD, price band [p_min, 1-p_min]
    h0: int                   # WAD, base half-spread
    c_delta: int              # WAD, multiplier on the gamma/delta spread term
    gamma0: int               # WAD, log-price basis uncertainty (fee band + quantisation)
    c_lag: int                # WAD, multiplier on sigma*sqrt(dt_epoch) (staleness)
    dt_epoch: int             # seconds per oracle epoch (12 L1, 2 Base, 1 Unichain/Arbitrum)
    Lam: int                  # WAD per whole token
    Qcap: int                 # units, |I| <= Qcap per epoch
    W_a: int = 0              # seconds, TWAP anchor window; 0 = start-of-block only
    tau_min: int = 0          # seconds, hard cutoff (>= settlement window + margin)
    c_inv: int = 0            # WAD, max one-sided inventory widening
    cap_inv: int = 1          # units, inventory scale for the widening
    k_max: int = None         # WAD; None -> derived from 1/z_band
    dual_gamma_inside: bool = True   # spec: gamma term inside the max/min (False = broken variant)
    halt_outside_band: bool = True   # spec: halt; False = clamp mid (broken variant)


def z_band(p_min):
    """Phi^{-1}(1 - p_min) as mpf."""
    p = mpf(p_min) / WAD
    return msqrt(2) * erfinv(1 - 2 * p)


@dataclass
class EpochQuote:
    a: int      # WAD, YES ask base (no impact)
    b: int      # WAD, YES bid base (no impact)
    k: object   # mpf, gamma coefficient (for diagnostics)
    A: int
    B: int
    up_ok: bool
    down_ok: bool


def epoch_quote(P: Params, x_sob: int, x_twap: int, now: int, E_start: int) -> EpochQuote:
    """Everything that is constant within one oracle epoch.  Pure function of epoch inputs."""
    tau = P.expiry - now
    if tau <= 0 or tau < P.tau_min:
        raise Halt("cutoff")
    w = P.sigma2 * tau // YEAR                       # WAD, floor
    if w == 0:
        raise Halt("w=0")
    sqrtw = isqrt(w * WAD)                           # WAD, floor
    # gamma_S = gamma0 + c_lag * sigma * sqrt(dt/YEAR)   (log-price units, WAD)
    sig_dt = isqrt(P.sigma2 * P.dt_epoch * WAD // YEAR)          # WAD, sigma*sqrt(dt)
    gammaS = P.gamma0 + P.c_lag * sig_dt // WAD
    k = (mpf(P.c_delta) / WAD) * (mpf(gammaS) / WAD) / (mpf(sqrtw) / WAD)
    kmax = (mpf(P.k_max) / WAD) if P.k_max is not None else 1 / z_band(P.p_min)
    if k > kmax:
        raise Halt("k>k_max (gamma cutoff)")
    xs = [x_sob] + ([x_twap] if P.W_a > 0 else [])

    def d2(x):
        return (mpf(x - P.lnK) - mpf(w) / 2) / mpf(sqrtw)

    if P.dual_gamma_inside:
        gp = [int(mceil((ncdf(d2(x)) + k * npdf(d2(x))) * WAD)) for x in xs]
        gm = [int(mfloor((ncdf(d2(x)) - k * npdf(d2(x))) * WAD)) for x in xs]
        A, B = max(gp), min(gm)
    else:  # broken variant: gamma computed from SoB only, added after the max/min
        Ps = [ncdf(d2(x)) for x in xs]
        g = k * npdf(d2(x_sob))
        A = int(mceil((max(Ps) + g) * WAD))
        B = int(mfloor((min(Ps) - g) * WAD))
    hinv_up = P.c_inv * max(E_start, 0) // P.cap_inv
    hinv_dn = P.c_inv * max(-E_start, 0) // P.cap_inv
    a = A + P.h0 + min(hinv_up, P.c_inv)
    b = B - P.h0 - min(hinv_dn, P.c_inv)
    if not P.halt_outside_band:   # broken variant: clamp the quote into the band instead of halting
        a = min(max(a, P.p_min), WAD - P.p_min)
        b = min(max(b, P.p_min), WAD - P.p_min)
    up_ok = P.p_min <= a <= WAD - P.p_min
    dn_ok = P.p_min <= b <= WAD - P.p_min
    return EpochQuote(a, b, k, A, B, up_ok, dn_ok)


# ----------------------------------------------------------------------------------------------
# Amount functions.  One generic convex "buy" and one concave "sell" in a mirrored coordinate.
#   buy  q from state I0 at base price a :  N(q) = Lam*q^2 + beta*q,   beta = 2*UNIT*a + 2*Lam*I0
#          cost = ceil(N/D)
#   sell q from state I0 at base price b :  M(q) = -Lam*q^2 + beta*q,  beta = 2*UNIT*b + 2*Lam*I0
#          proceeds = floor(M/D)
# YES buy  : buy  at (a,  I)      -> I += q
# YES sell : sell at (b,  I)      -> I -= q
# NO  buy  : buy  at (1-b, -I)    -> I -= q      (mirror: NO ask = 1 - YES bid)
# NO  sell : sell at (1-a, -I)    -> I += q      (mirror: NO bid = 1 - YES ask)
# ----------------------------------------------------------------------------------------------

def N_buy(Lam, a, I0, q):
    return Lam * q * q + (2 * UNIT * a + 2 * Lam * I0) * q


def M_sell(Lam, b, I0, q):
    return -Lam * q * q + (2 * UNIT * b + 2 * Lam * I0) * q


def buy_exact_out(Lam, a, I0, q):
    return ceil_div(N_buy(Lam, a, I0, q), D)


def buy_exact_in(Lam, a, I0, A, fixup=True):
    """max q with ceil(N(q)/D) <= A  <=>  N(q) <= A*D."""
    beta = 2 * UNIT * a + 2 * Lam * I0
    if beta <= 0:
        raise Halt("band(start)")
    R = A * D
    if Lam == 0:
        return R // beta
    disc = beta * beta + 4 * Lam * R
    q = (isqrt(disc) - beta) // (2 * Lam)           # candidate, always feasible (proof in report)
    if fixup:   # defensive: provably never changes q when disc is an exact integer (report 3.3)
        assert N_buy(Lam, a, I0, q) <= R < N_buy(Lam, a, I0, q + 1)
    return q


def buy_exact_in_naive_wad(Lam, a, I0, A):
    """What a straightforward WAD port of 05 3.6 does: q = (sqrt(a0^2 + 2 lam A) - a0) / lam with
    every intermediate rounded to WAD (lam per unit = Lam/1e6 truncated, sqrtWad, divWad)."""
    lam_u = Lam // UNIT                                  # WAD per unit (truncates!)
    a0 = a + lam_u * I0                                  # WAD
    A_w = A * WAD // UNIT                                # USDC amount as WAD... per unit price basis
    if lam_u == 0:
        return A * WAD // a0
    disc = a0 * a0 // WAD + 2 * lam_u * A * WAD // WAD   # WAD
    r = isqrt(disc * WAD)                                # sqrtWad, floor
    return (r - a0) // lam_u


def sell_exact_in(Lam, b, I0, q):
    return M_sell(Lam, b, I0, q) // D


def sell_exact_out(Lam, b, I0, A, fixup=True):
    """min q with floor(M(q)/D) >= A  <=>  M(q) >= A*D, on the increasing branch."""
    beta = 2 * UNIT * b + 2 * Lam * I0
    if beta <= 0:
        raise Halt("band(start)")
    R = A * D
    if Lam == 0:
        return ceil_div(R, beta)
    disc = beta * beta - 4 * Lam * R
    if disc < 0:
        raise Halt("sell exact-out: amount unreachable")
    r = isqrt(disc)
    q = ceil_div(beta - r, 2 * Lam)                  # candidate, always feasible
    if fixup:   # defensive: provably never changes q (report 3.3)
        assert M_sell(Lam, b, I0, q) >= R and (q == 0 or M_sell(Lam, b, I0, q - 1) < R)
    return q


# ----------------------------------------------------------------------------------------------
# Market state machine for one market within one epoch
# ----------------------------------------------------------------------------------------------

@dataclass
class Market:
    P: Params
    I: int = 0            # net YES-equivalent sold this epoch
    E: int = 0            # cumulative net YES-equivalent sold (vault exposure), all epochs
    epoch: int = -1       # key of the epoch I belongs to (block.timestamp)

    def roll(self, now):
        if now != self.epoch:
            self.epoch = now
            self.I = 0

    # --- band and cap checks, in YES space.  side = +1 up (ask curve), -1 down (bid curve)
    def _check(self, q_up, base, I0, I1, side):
        P = self.P
        lo, hi = min(I0, I1), max(I0, I1)
        # marginal price in WAD*UNIT units: UNIT*base + Lam*x ; check x in {0 (mid), lo, hi}
        for x in (lo, hi):
            m = UNIT * base + P.Lam * x
            if not (UNIT * P.p_min <= m <= UNIT * (WAD - P.p_min)):
                raise Halt("band")
        if abs(I1) > P.Qcap:
            raise Halt("Qcap")

    def _q(self, x_sob, x_twap, now):
        self.roll(now)
        return epoch_quote(self.P, x_sob, x_twap, now, self.E - self.I)

    # ---------------- YES ----------------
    def buy_yes_in(self, x_sob, x_twap, now, A):
        Q = self._q(x_sob, x_twap, now)
        if not Q.up_ok:
            raise Halt("band(mid)")
        q = buy_exact_in(self.P.Lam, Q.a, self.I, A)
        if q == 0:
            raise Halt("zero out")
        self._check(q, Q.a, self.I, self.I + q, +1)
        self.I += q; self.E += q
        return A, q            # (paid USDC, got YES)  -- exact-in: the full A is taken

    def buy_yes_out(self, x_sob, x_twap, now, q):
        Q = self._q(x_sob, x_twap, now)
        if not Q.up_ok:
            raise Halt("band(mid)")
        self._check(q, Q.a, self.I, self.I + q, +1)
        c = buy_exact_out(self.P.Lam, Q.a, self.I, q)
        self.I += q; self.E += q
        return c, q

    def sell_yes_in(self, x_sob, x_twap, now, q):
        Q = self._q(x_sob, x_twap, now)
        if not Q.down_ok:
            raise Halt("band(mid)")
        self._check(q, Q.b, self.I, self.I - q, -1)
        p = sell_exact_in(self.P.Lam, Q.b, self.I, q)
        self.I -= q; self.E -= q
        return q, p            # (gave YES, got USDC)

    def sell_yes_out(self, x_sob, x_twap, now, A):
        Q = self._q(x_sob, x_twap, now)
        if not Q.down_ok:
            raise Halt("band(mid)")
        q = sell_exact_out(self.P.Lam, Q.b, self.I, A)
        self._check(q, Q.b, self.I, self.I - q, -1)
        self.I -= q; self.E -= q
        return q, A

    # ---------------- NO (mirror) ----------------
    def buy_no_in(self, x_sob, x_twap, now, A):
        Q = self._q(x_sob, x_twap, now)
        if not Q.down_ok:
            raise Halt("band(mid)")
        q = buy_exact_in(self.P.Lam, WAD - Q.b, -self.I, A)
        if q == 0:
            raise Halt("zero out")
        self._check(q, Q.b, self.I, self.I - q, -1)
        self.I -= q; self.E -= q
        return A, q

    def buy_no_out(self, x_sob, x_twap, now, q):
        Q = self._q(x_sob, x_twap, now)
        if not Q.down_ok:
            raise Halt("band(mid)")
        self._check(q, Q.b, self.I, self.I - q, -1)
        c = buy_exact_out(self.P.Lam, WAD - Q.b, -self.I, q)
        self.I -= q; self.E -= q
        return c, q

    def sell_no_in(self, x_sob, x_twap, now, q):
        Q = self._q(x_sob, x_twap, now)
        if not Q.up_ok:
            raise Halt("band(mid)")
        self._check(q, Q.a, self.I, self.I + q, +1)
        p = sell_exact_in(self.P.Lam, WAD - Q.a, -self.I, q)
        self.I += q; self.E += q
        return q, p

    def sell_no_out(self, x_sob, x_twap, now, A):
        Q = self._q(x_sob, x_twap, now)
        if not Q.up_ok:
            raise Halt("band(mid)")
        q = sell_exact_out(self.P.Lam, WAD - Q.a, -self.I, A)
        self._check(q, Q.a, self.I, self.I + q, +1)
        self.I += q; self.E += q
        return q, A


def default_params(now=1_800_000_000, tau=86400, **kw):
    import math
    base = dict(
        lnK=int(math.log(5000) * WAD), expiry=now + tau, sigma2=int(0.36 * WAD),
        p_min=int(0.02 * WAD), h0=int(0.003 * WAD), c_delta=int(1.0 * WAD),
        gamma0=int(5.5e-4 * WAD), c_lag=int(0.8 * WAD), dt_epoch=12,
        Lam=10**13,              # 1e-5 USDC per token per token  (depth l = 1e5 tokens per $1)
        Qcap=50_000 * UNIT, W_a=0, tau_min=1800,
        c_inv=int(0.01 * WAD), cap_inv=200_000 * UNIT)
    base.update(kw)
    return Params(**base)
