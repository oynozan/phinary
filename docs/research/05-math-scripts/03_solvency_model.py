"""
03 - Reference state machine for the complete-set collateral vault + randomized invariant fuzzing.
Units: USDC and outcome tokens both in 1e-6 units (same decimals => mint/merge exact 1:1).
Prices in WAD (1e18). Asks rounded UP, bids rounded DOWN (in favour of the vault).
This is the executable spec that Foundry invariant tests (handler + ghost variables) should mirror.
"""
import random

WAD = 10**18


def ceil_div(a, b):
    return -(-a // b)


class Market:
    def __init__(s, U0, cap):
        s.C = 0; s.Ys = 0; s.Ns = 0          # collateral, supplies
        s.Yv = 0; s.Nv = 0; s.U = U0         # vault inventory, vault free cash
        s.cap = cap                          # max vault inventory per side (outcome-risk cap)
        s.traders = {}
        s.settled = None
        s.fees = 0

    def T(s, i):
        return s.traders.setdefault(i, dict(cash=10**12, Y=0, N=0))

    # ---- vault helpers
    def _mint_vault(s, m):
        assert s.U >= m, "vault cash"
        s.U -= m; s.C += m; s.Ys += m; s.Ns += m; s.Yv += m; s.Nv += m

    def _net(s):
        k = min(s.Yv, s.Nv)
        s.Yv -= k; s.Nv -= k; s.Ys -= k; s.Ns -= k; s.C -= k; s.U += k

    # ---- trader ops (atomic: revert == no state change)
    def buy(s, i, side, q, p_ask):
        t = s.T(i)
        cost = ceil_div(q * p_ask, WAD)
        inv = 'Yv' if side == 'Y' else 'Nv'
        short = max(0, q - getattr(s, inv))
        if t['cash'] < cost or s.U + cost < short:
            return False
        # cap on vault's opposite inventory after the trade
        opp_after = (s.Nv if side == 'Y' else s.Yv) + short
        if opp_after > s.cap:
            return False
        t['cash'] -= cost; s.U += cost
        if short:
            s._mint_vault(short)
        setattr(s, inv, getattr(s, inv) - q)
        t[side] += q
        s._net()
        return True

    def sell(s, i, side, q, p_bid):
        t = s.T(i)
        if t[side] < q:
            return False
        proceeds = (q * p_bid) // WAD
        inv = 'Yv' if side == 'Y' else 'Nv'
        # vault must be able to pay after netting
        k = min(getattr(s, inv) + q, s.Nv if side == 'Y' else s.Yv)
        if s.U + k < proceeds:
            return False
        if getattr(s, inv) + q - k > s.cap:
            return False
        t[side] -= q; setattr(s, inv, getattr(s, inv) + q)
        s._net()
        s.U -= proceeds; t['cash'] += proceeds
        return True

    def mint(s, i, a):
        t = s.T(i)
        if t['cash'] < a:
            return False
        t['cash'] -= a; s.C += a; s.Ys += a; s.Ns += a; t['Y'] += a; t['N'] += a
        return True

    def merge(s, i, a):
        t = s.T(i)
        if min(t['Y'], t['N']) < a:
            return False
        t['Y'] -= a; t['N'] -= a; s.C -= a; s.Ys -= a; s.Ns -= a; t['cash'] += a
        return True

    def settle(s, yes_wins):
        s.settled = yes_wins
        # vault redeems its own winning inventory
        w = s.Yv if yes_wins else s.Nv
        s.C -= w; s.U += w
        if yes_wins:
            s.Ys -= s.Yv; s.Yv = 0; s.Ns -= s.Nv; s.Nv = 0
        else:
            s.Ns -= s.Nv; s.Nv = 0; s.Ys -= s.Yv; s.Yv = 0

    def redeem(s, i):
        t = s.T(i)
        amt = t['Y'] if s.settled else t['N']
        assert s.C >= amt, "INSOLVENT"
        s.C -= amt; t['cash'] += amt
        s.Ys -= t['Y']; s.Ns -= t['N']      # burn both (losing side redeems for 0)
        t['Y'] = 0; t['N'] = 0


def total_cash(m):
    return sum(t['cash'] for t in m.traders.values()) + m.U + m.C


def check(m, total0):
    assert m.C >= 0 and m.U >= 0
    if m.settled is None:
        assert m.C == m.Ys == m.Ns, (m.C, m.Ys, m.Ns)                    # I1
        assert min(m.Yv, m.Nv) == 0                                     # I4
        assert max(m.Yv, m.Nv) <= m.cap                                 # outcome-risk cap
        # I6 MTM zero-sum at an arbitrary common mark p
        p = random.randint(0, WAD)
        val = sum(t['cash'] * WAD + p * t['Y'] + (WAD - p) * t['N'] for t in m.traders.values())
        val += m.U * WAD + p * m.Yv + (WAD - p) * m.Nv
        assert val == total0 * WAD, "MTM conservation"
    else:
        win = m.Ys if m.settled else m.Ns
        assert m.C == win, (m.C, win)                                    # post-settlement solvency
    assert total_cash(m) == total0                                      # I3 conservation (+I2 if C,U are balances)


def run(seed, n_ops=4000, spread_bps=100, arb_violation=False):
    random.seed(seed)
    m = Market(U0=5 * 10**9, cap=3 * 10**9)
    for i in range(10):
        m.T(i)
    total0 = total_cash(m)
    lp0 = m.U
    for _ in range(n_ops):
        P = random.randint(WAD // 100, WAD - WAD // 100)   # model mid price (any value in (0,1))
        h = spread_bps * WAD // 20000
        askY, bidY = min(WAD, P + h), max(0, P - h)
        askN, bidN = min(WAD, WAD - P + h), max(0, WAD - P - h)
        if arb_violation:
            bidY, bidN = P + h, WAD - P + h        # broken quoting: bidY + bidN > 1
        assert askY + askN >= WAD or arb_violation
        i = random.randrange(10)
        op = random.random()
        q = random.randint(1, 10**8)
        if op < 0.3:
            m.buy(i, 'Y', q, askY)
        elif op < 0.5:
            m.buy(i, 'N', q, askN)
        elif op < 0.7:
            m.sell(i, 'Y', min(q, m.T(i)['Y']), bidY) if m.T(i)['Y'] else None
        elif op < 0.85:
            m.sell(i, 'N', min(q, m.T(i)['N']), bidN) if m.T(i)['N'] else None
        elif op < 0.93:
            m.mint(i, q)
        else:
            m.merge(i, min(q, m.T(i)['Y'], m.T(i)['N']))
        check(m, total0)
    yes = random.random() < 0.5
    m.settle(yes)
    check(m, total0)
    for i in list(m.traders):
        m.redeem(i)
        check(m, total0)
    assert m.C == 0 and m.Ys == 0 and m.Ns == 0
    return m.U - lp0


if __name__ == "__main__":
    pnl = [run(s) for s in range(60)]
    print(f"60 random runs x 4000 ops: all invariants held. LP P&L (USDC): min={min(pnl)/1e6:.0f} max={max(pnl)/1e6:.0f}")
    # demonstrate that a quote with bidY + bidN > 1 is exploitable: mint set, sell both legs
    random.seed(0)
    m = Market(U0=10**9, cap=10**12)
    t = m.T(0)
    total0 = total_cash(m)
    c0 = t['cash']
    for _ in range(100):
        m.mint(0, 10**6)
        m.sell(0, 'Y', 10**6, 51 * WAD // 100)
        m.sell(0, 'N', 10**6, 51 * WAD // 100)
    print("bidY+bidN=1.02 exploit: trader profit after 100 loops =", (m.T(0)['cash'] - c0) / 1e6, "USDC (vault drained by the same)")
    check(m, total0)
