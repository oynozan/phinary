"""FROZEN v1 SPEC (integrated): one place for every constant the Python sim and the Foundry tests share.
All closed forms here are the ones the report restates (discrete geometric-Asian binary, ramp, gamma term, caps, cutoffs).
Units: log prices natural log; time in years unless suffixed; money in USD unless 'B units'."""
import numpy as np
from math import sqrt, log, pi, exp
from scipy.stats import norm

YEAR_S = 365 * 86400
MPY = 365 * 1440
LN1 = log(1.0001)

# ---------------------------------------------------------------- chains / sources
CHAIN = {
    # dt_s: block time; yv: virtual USDC reserve of the v3 5bp WETH/USDC oracle source; f: fee band
    # c_manip: attacker cost per unit log shift of one SoB (fees-only, quote report 7.2: $773 per 1% on mainnet v3 5bp)
    # kin: in-band manipulation-cost coefficient per block (settlement report 2.2/3.3: 0.10 conservative on L1;
    #      L2 = 0.10 * 1.75 / 6 from out01 '5 bp, L2 dt=2 s' row (UNVERIFIED on real L2 data))
    'L1': dict(dt_s=12.0, yv=155.5e6, f=5e-4, c_manip=77_300.0, kin=0.10, name='Ethereum L1, v3 USDC/WETH 5 bp'),
    'L2': dict(dt_s=2.0, yv=67.0e6, f=5e-4, c_manip=77_300.0 * 67.0 / 155.5, kin=0.10 * 1.75 / 6.0, name='Base, v3 WETH/USDC 5 bp'),
}

# ---------------------------------------------------------------- quote constants (quote-function report 2.1)
PMIN = 0.02
C_DELTA = 1.0
GAMMA0 = 5.5e-4          # pool fee 5 bp + 0.5 bp tick quantisation
C_LAG = 0.8
B_SETTLE = 5 * 60        # b: seconds between trading cutoff and window start (settlement report 6)

# ---------------------------------------------------------------- sigma (oracle report 3.1), mode A
H_S = 300; W_WIN = 864; WINSOR_TICKS = 400
SIG_FLOOR, SIG_CAP = 0.20, 2.50
def beta_yr(f=5e-4, H=H_S):
    """Additive fee-band correction 0.5*gamma^2/H, per year."""
    return 0.5 * f * f / H * YEAR_S


def w_eff(w_s, dt_s):
    """Discrete-Asian window variance term Delta*(n-1)(2n-1)/(6n) (seconds)."""
    n = int(round(w_s / dt_s))
    return dt_s * (n - 1) * (2 * n - 1) / (6 * n), n


def asian_mu_v(lnSK, sigma, tau_s, w_s, dt_s):
    """Pre-window discrete geometric-Asian binary (settlement report 4.4). Returns (mu, v) with v a variance (not annualised
    per-second: in plain log^2 units). Requires tau_s >= w_s."""
    we, n = w_eff(w_s, dt_s)
    s2 = sigma * sigma / YEAR_S
    mu = lnSK - 0.5 * s2 * (tau_s - w_s + (n - 1) * dt_s / 2)
    v = s2 * ((tau_s - w_s) + we)
    return mu, v


def price_binary(lnSK, sigma, tau_s, w_s, dt_s):
    mu, v = asian_mu_v(lnSK, sigma, tau_s, w_s, dt_s)
    return norm.cdf(mu / np.sqrt(v))


def psi(z, sv):
    return z * norm.cdf(z / sv) + sv * norm.pdf(z / sv)


def price_ramp(lnSK, sigma, tau_s, w_s, dt_s, h):
    mu, v = asian_mu_v(lnSK, sigma, tau_s, w_s, dt_s); sv = np.sqrt(v)
    return (psi(mu + h, sv) - psi(mu - h, sv)) / (2 * h)


def gamma_S(sigma, dt_s):
    return GAMMA0 + C_LAG * sigma * sqrt(dt_s / YEAR_S)


# ---------------------------------------------------------------- cutoffs (seconds before T at which trading stops)
def cut_window(w_s):
    return w_s + B_SETTLE


def cut_tenor10(tenor_s, w_s):
    """10%-of-tenor cutoff; only legal if >= w + b (else trading would continue inside the settlement window)."""
    return max(0.1 * tenor_s, w_s + B_SETTLE)


def cut_05(h0, w_s, dt_s):
    """Report 05's tau_cut = dt*(phi(0)/s)^2 (per-block ATM mid sd equals the half-spread), restated for the Asian
    variance: sigma cancels; tau* = dt*(phi(0)/h0)^2 + (w - w_eff). Never earlier than w + b."""
    we, _ = w_eff(w_s, dt_s)
    return max(dt_s * (norm.pdf(0) / h0) ** 2 + (w_s - we), w_s + B_SETTLE)


# ---------------------------------------------------------------- caps
def k_w(chain, w_s):
    c = CHAIN[chain]; return c['kin'] * (w_s / c['dt_s']) * c['yv']


def q_safe_binary(chain, w_s, sigma, tau_cut_s, spread):
    """Settlement OI cap (settlement report 3.1): Q_safe = 8*pi*s*k_w*sd_G^2, sd_G^2 = v at the cutoff. USD of payout."""
    _, v = asian_mu_v(0.0, sigma, tau_cut_s, w_s, CHAIN[chain]['dt_s'])
    return 8 * pi * spread * k_w(chain, w_s) * v


def q_safe_ramp(chain, w_s, h, spread):
    return 16 * spread * k_w(chain, w_s) * h * h


def q_epoch_tokens(chain, sigma, tau_s, w_s, dphi=norm.pdf(0), m_a=1.0):
    """Per-epoch |I| cap (quote report 7.2) restated for the Asian delta: Q = m_a*c*sqrt(v)/phi(d)."""
    c = CHAIN[chain]; _, v = asian_mu_v(0.0, sigma, tau_s, w_s, c['dt_s'])
    return m_a * c['c_manip'] * np.sqrt(v) / dphi


if __name__ == '__main__':
    for ch in CHAIN:
        dt = CHAIN[ch]['dt_s']
        for wm in (30, 120, 240):
            w = wm * 60
            for h0 in (0.005, 0.01, 0.02):
                print(ch, wm, 'h0', h0, 'cut w+b', cut_window(w) / 60, 'cut10', cut_tenor10(86400, w) / 60, 'cut05 %.0f min' % (cut_05(h0, w, dt) / 60),
                      'Qsafe(sig .6, cut w+b) $%.0f' % q_safe_binary(ch, w, 0.6, cut_window(w), h0))
    print('beta/yr', beta_yr())
