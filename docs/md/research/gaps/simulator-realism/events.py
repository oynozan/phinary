"""Scheduled-event calendar (CPI, FOMC, ETF decisions/launches, ETH network upgrades) and walk-forward event-variance estimates.
Times are the scheduled release time in UTC (US events converted from America/New_York, DST-aware)."""
import numpy as np, datetime as dt, sys, os
from zoneinfo import ZoneInfo
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'econ'))
NY = ZoneInfo('America/New_York'); UTC = dt.timezone.utc
# BLS CPI release dates (08:30 ET). 2021-2025 from bls.gov/bls/news-release/cpi.htm (two summariser errors corrected: 2024-01-11, 2025-01-15;
# 2025-10-24 delayed release; no Nov-2025 release, Dec-2025 on 2025-12-18). 2026 from bls.gov/schedule/news_release/cpi.htm. 2020 from memory (warm-up only).
CPI = """2020-01-14 2020-02-13 2020-03-11 2020-04-10 2020-05-12 2020-06-10 2020-07-14 2020-08-12 2020-09-11 2020-10-13 2020-11-12 2020-12-10
2021-01-13 2021-02-10 2021-03-10 2021-04-13 2021-05-12 2021-06-10 2021-07-13 2021-08-11 2021-09-14 2021-10-13 2021-11-10 2021-12-10
2022-01-12 2022-02-10 2022-03-10 2022-04-12 2022-05-11 2022-06-10 2022-07-13 2022-08-10 2022-09-13 2022-10-13 2022-11-10 2022-12-13
2023-01-12 2023-02-14 2023-03-14 2023-04-12 2023-05-10 2023-06-13 2023-07-12 2023-08-10 2023-09-13 2023-10-12 2023-11-14 2023-12-12
2024-01-11 2024-02-13 2024-03-12 2024-04-10 2024-05-15 2024-06-12 2024-07-11 2024-08-14 2024-09-11 2024-10-10 2024-11-13 2024-12-11
2025-01-15 2025-02-12 2025-03-12 2025-04-10 2025-05-13 2025-06-11 2025-07-15 2025-08-12 2025-09-11 2025-10-24 2025-12-18
2026-01-13 2026-02-13 2026-03-11 2026-04-10 2026-05-12 2026-06-10 2026-07-14 2026-08-12 2026-09-11""".split()
# FOMC statement days (14:00 ET) from federalreserve.gov/monetarypolicy/fomccalendars.htm; 2020 from memory (warm-up only; emergency cuts excluded).
FOMC = """2020-01-29 2020-04-29 2020-06-10 2020-07-29 2020-09-16 2020-11-05 2020-12-16
2021-01-27 2021-03-17 2021-04-28 2021-06-16 2021-07-28 2021-09-22 2021-11-03 2021-12-15
2022-01-26 2022-03-16 2022-05-04 2022-06-15 2022-07-27 2022-09-21 2022-11-02 2022-12-14
2023-02-01 2023-03-22 2023-05-03 2023-06-14 2023-07-26 2023-09-20 2023-11-01 2023-12-13
2024-01-31 2024-03-20 2024-05-01 2024-06-12 2024-07-31 2024-09-18 2024-11-07 2024-12-18
2025-01-29 2025-03-19 2025-05-07 2025-06-18 2025-07-30 2025-09-17 2025-10-29 2025-12-10
2026-01-28 2026-03-18 2026-04-29 2026-06-17 2026-07-29 2026-09-16""".split()
# ETF decisions / launches with a publicly known date (time = approximate announcement/launch time, UTC). UNVERIFIED to the minute.
ETF = [('2024-01-10 21:00', 'BTC spot ETF approval (deadline day)'), ('2024-01-11 14:30', 'BTC spot ETF launch'),
       ('2024-05-23 20:30', 'ETH spot ETF 19b-4 decision (VanEck deadline)'), ('2024-07-23 13:30', 'ETH spot ETF launch')]
# ETH network upgrades (mainnet activation, UTC).
UPG = [('2022-09-15 06:43', 'Merge'), ('2023-04-12 22:27', 'Shapella'), ('2024-03-13 13:55', 'Dencun'), ('2025-05-07 10:05', 'Pectra')]
def ny(d, hh, mm):
    return dt.datetime.strptime(d, '%Y-%m-%d').replace(hour=hh, minute=mm, tzinfo=NY).astimezone(UTC)
def calendar():
    ev = [(ny(d, 8, 30), 'CPI') for d in CPI] + [(ny(d, 14, 0), 'FOMC') for d in FOMC]
    ev += [(dt.datetime.strptime(s, '%Y-%m-%d %H:%M').replace(tzinfo=UTC), 'ETF') for s, _ in ETF]
    ev += [(dt.datetime.strptime(s, '%Y-%m-%d %H:%M').replace(tzinfo=UTC), 'UPG') for s, _ in UPG]
    return sorted(ev)
CLS = {'CPI': 0, 'FOMC': 1, 'ETF': 2, 'UPG': 3}
PRE, POST = 5, 90     # event window [t_e - PRE, t_e + POST) minutes (FOMC press conference ends ~60-75 min after statement)

def event_arrays(lib, cex, sig_raw, SC=None, min_prior=6):
    """Returns ev_min (minute index of event), ev_cls, ev_J2 (walk-forward excess log-variance over the event window, using only
    events of the same class strictly before this one; pooled across classes until min_prior same-class events exist), ev_raw (realised
    excess for diagnostics)."""
    evs = calendar()
    T0 = lib.T0
    mins = np.array([int((e.timestamp()*1000 - T0)//60000) for e, _ in evs]); cls = np.array([CLS[c] for _, c in evs])
    ok = (mins > PRE + 1) & (mins + POST < lib.N); mins, cls = mins[ok], cls[ok]
    r = np.diff(cex)
    raw = np.zeros(len(mins))
    for i, m in enumerate(mins):
        rv = np.sum(r[m-PRE:m+POST]**2)                       # realised variance of 1-m returns over the window
        base = sig_raw[m-PRE-1]**2*(PRE+POST)/lib.MPY          # hook's own sigma forecast for that window (known before)
        raw[i] = rv - base
    J2 = np.zeros(len(mins))
    for i in range(len(mins)):
        same = np.where((cls == cls[i]) & (np.arange(len(mins)) < i))[0]
        prior = same if len(same) >= min_prior else np.where(np.arange(len(mins)) < i)[0]
        J2[i] = max(np.mean(raw[prior]), 0.0) if len(prior) >= 3 else 0.0
    return mins.astype(np.int64), cls.astype(np.int64), J2, raw

if __name__ == '__main__':
    import lib
    cex = lib.LOGS; sig = lib.ewma_sigma(lib.POOL, 1440)
    m, c, J2, raw = event_arrays(lib, cex, sig)
    r = np.diff(cex)
    # verification: is the release minute a volatility spike? |r| at [t_e, t_e+2) vs median |r| over same minute-of-day on the 20 prior days
    names = {v: k for k, v in CLS.items()}
    for k in range(4):
        s = c == k
        ratio = []
        for mm in m[s]:
            spike = np.abs(r[mm:mm+2]).max()
            ctrl = np.median([np.abs(r[mm-1440*d:mm-1440*d+2]).max() for d in range(1, 21)])
            ratio.append(spike/max(ctrl, 1e-9))
        ratio = np.array(ratio)
        ann = np.sqrt(np.maximum(raw[s], 0)).mean()
        print(f"{names[k]:>5}: n={s.sum()} spike ratio median {np.median(ratio):.1f}, share>2x {np.mean(ratio > 2):.2f} | mean excess var "
              f"{raw[s].mean():.2e} (= {100*np.sqrt(max(raw[s].mean(),0)):.2f}% move-equivalent) | median {np.median(raw[s]):.2e} | walk-fwd J2 last {J2[s][-1]:.2e}")
    # which CPI dates do NOT spike (possible date errors)
    s = np.where(c == 0)[0]
    import datetime as dt
    for i in s:
        mm = m[i]; spike = np.abs(r[mm:mm+2]).max(); ctrl = np.median([np.abs(r[mm-1440*d:mm-1440*d+2]).max() for d in range(1, 21)])
        if spike/ctrl < 1.5: print('  weak CPI spike', dt.datetime.fromtimestamp((lib.T0+mm*60000)/1000, dt.timezone.utc), round(spike/ctrl, 2))
    np.savez('events.npz', m=m, c=c, J2=J2, raw=raw)
