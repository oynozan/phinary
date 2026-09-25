"""Shared helpers for the settlement-rule / in-band manipulation study (gap report).
Units: log-prices in natural log; costs in multiples of y_v (virtual USDC reserve L*sqrt(P) of the active range)."""
import numpy as np
from math import sqrt, log, pi, erf, exp
YEAR = 365 * 86400
LN1 = log(1.0001)


def push_cost(a, b, fee):
    """Attacker cost (units of y_v) of moving the pool log-price from a to b (both measured relative to the
    reference log-price X, i.e. a = Y_before - X), constant L inside the range, marked to the reference price,
    LP fee `fee` charged on the input amount. Works elementwise for buys (b > a) and sells (b < a)."""
    a = np.asarray(a, float); b = np.asarray(b, float)
    up = b > a
    # buy ETH: pay USDC dy = y_v (e^{b/2}-e^{a/2}) (+fee), receive dx worth y_v (e^{-a/2}-e^{-b/2}) at ref
    buy = (1 + fee) * (np.exp(b / 2) - np.exp(a / 2)) - (np.exp(-a / 2) - np.exp(-b / 2))
    # sell ETH: give dx worth y_v (e^{-b/2}-e^{-a/2}) (+fee in ETH), receive USDC y_v (e^{a/2}-e^{b/2})
    sell = (1 + fee) * (np.exp(-b / 2) - np.exp(-a / 2)) - (np.exp(a / 2) - np.exp(b / 2))
    return np.where(up, buy, np.where(b < a, sell, 0.0))


def simulate_floor_attack(sig, dt, f, n_w, s_list, npaths=20000, burn=200, noise_p=0.0, noise_sd=0.0,
                          seed=1, X_paths=None):
    """Band-follower pool (arbs at top of block clip Y into [X-f, X+f]); optional noise trade after the arbs;
    attacker at the bottom of the block buys up to the floor X - f + s (s >= 0; s > 2f pushes above the band).
    The oracle sample of block k is the end-of-block Y (held until the next block).
    Returns dict s -> (mean shift of the window mean, mean cost, sd cost), all in log units / y_v units.
    If X_paths (npaths x (burn+n_w+1)) is given it is used as the reference instead of GBM."""
    rng = np.random.default_rng(seed)
    nb = burn + n_w
    if X_paths is None:
        sb = sig * sqrt(dt / YEAR)
        dX = rng.normal(-0.5 * sb * sb, sb, (npaths, nb))
        X = np.concatenate([np.zeros((npaths, 1)), np.cumsum(dX, 1)], 1)
    else:
        X = X_paths; npaths = X.shape[0]; nb = X.shape[1] - 1
    if noise_p > 0:
        nz = (rng.random((npaths, nb)) < noise_p) * rng.normal(0, noise_sd, (npaths, nb))
    else:
        nz = np.zeros((npaths, nb))
    out = {}
    # counterfactual
    Y = X[:, 0].copy(); ycf = np.zeros((npaths, n_w))
    for k in range(1, nb + 1):
        Y = np.clip(Y, X[:, k] - f, X[:, k] + f) + nz[:, k - 1]
        if k > burn: ycf[:, k - burn - 1] = Y
    for s in s_list:
        Y = X[:, 0].copy(); ya = np.zeros((npaths, n_w)); cost = np.zeros(npaths)
        for k in range(1, nb + 1):
            Y = np.clip(Y, X[:, k] - f, X[:, k] + f) + nz[:, k - 1]
            if k > burn:
                F = X[:, k] - f + s
                need = Y < F
                c = push_cost(Y - X[:, k], F - X[:, k], f)
                cost += np.where(need, c, 0.0)
                Y = np.where(need, F, Y)
                ya[:, k - burn - 1] = Y
        shift = (ya - ycf).mean(1)
        out[s] = (shift.mean(), cost.mean(), cost.std(), shift.std())
    return out


def norm_cdf(x):
    return 0.5 * (1 + erf(x / sqrt(2)))
