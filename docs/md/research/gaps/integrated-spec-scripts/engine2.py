"""Integrated-spec engine: a SERIES (7 strikes, one expiry, one settlement window) is simulated jointly so that the exact ladder
cap, the settlement OI cap and the settlement manipulation charge can be enforced/charged. Everything in units of the per-market
budget B (tokens of $1 payout / B_usd).

Quote (per market, per step; quote-function report 2.2 restated for the discrete-Asian mid, settlement report 4.4):
  mu = x - lnK - a,  a = 0.5 s^2 (tau - w + (n-1)D/2),  v = s^2 ((tau - w) + D(n-1)(2n-1)/(6n))
  P = Phi(mu/sqrt v)            (kid 0)   or variance-matched Student-t (kid 2)    or ramp (h > 0, kid 0 only)
  P' = dP/dx ;  ask = P + c_delta*gamma_S*P' + h0 ;  bid = P - c_delta*gamma_S*P' - h0
  up side (YES buy / NO sell) enabled iff pmin <= ask <= 1-pmin; down side iff pmin <= bid <= 1-pmin (halt, no clamp)
  every executed marginal price stays in band; linear impact lam_step on ONE signed I per market, reset each step/block
  |I| <= Qcap_step (per-epoch manipulation cap, quote 7.2, Asian delta)
  per-market budget  min(c_m, c_m + y_m) >= -Bm ; ladder  min_j W_j >= -Bs  (LP-vault report 5.1), exact quadratic solve
  settlement gross delta-weighted OI:  sum_m gross_m * exp(-0.5((g - lnK_m)/sdG)^2) <= Qsafe  for g on {lnK_i} U midpoints
Settlement: G = mean of end-of-sample pool log price over [T-w, T) (n samples, one per `samp` steps). Strict: YES iff G > lnK.
Manipulation (clairvoyant, per path): attacker holds the counterparty of every vault position that a shift delta would flip against
the vault; picks delta (both directions) maximising  sum flipped gains - C(delta); if > 0 the shifted outcome is used.

params P (float64):
 0 h0  1 c_delta  2 gam0  3 c_lag  4 dt_block_yr  5 lam_step  6 cut_steps  7 pmin  8 w_steps  9 samp_steps  10 dsamp_yr
 11 Bm 12 Bs 13 c_manip_B (per unit log, B units; 0=off) 14 m_a 15 R (epochs per step) 16 noise_q (B units) 17 noise_p (per step)
 18 lat 19 tail 20 iv 21 orv 22 dir 23 kid 24 nu_sc 25 ramp_h 26 manip_on 27 step_yr 28 blk (steps per block, SoB/reset)
 29 m_lat 30 m_tail 31 m_dir 32 dir_step 33 dir_pos 34 lam_block (noise own-impact) 35 fixed_sigma 36 oi_on
"""
import numpy as np, math
from numba import njit
from engine import XG, BUCKETS, tab, bucket_of, ncdf, npdf

BUCKETS_ = BUCKETS.astype(np.float64)
XG_ = XG

@njit(cache=True)
def tpdf_tab(xg, ft, x):
    # numerical derivative of the tabulated t cdf
    h = 1e-4
    return (tab(xg, ft, x + h) - tab(xg, ft, x - h)) / (2 * h)

@njit(cache=True)
def quote_core(kid, x, lnK, a, sd, ttab, nusc, rh):
    """returns (P, dP/dx)"""
    mu = x - lnK - a
    if rh > 0.0:
        up = mu + rh; dn = mu - rh
        pu = up * ncdf(up / sd) + sd * npdf(up / sd)
        pd = dn * ncdf(dn / sd) + sd * npdf(dn / sd)
        return (pu - pd) / (2 * rh), (ncdf(up / sd) - ncdf(dn / sd)) / (2 * rh)
    d = mu / sd
    if kid == 2:
        z = d / nusc
        return tab(XG_, ttab, z), tpdf_tab(XG_, ttab, z) / (sd * nusc)
    return ncdf(d), npdf(d) / sd

@njit(cache=True)
def emp_p(z, Qrow):
    n = len(Qrow)
    if z <= Qrow[0]: return 1.0
    if z >= Qrow[n-1]: return 0.0
    lo = 0; hi = n-1
    while hi - lo > 1:
        mid = (lo+hi)//2
        if Qrow[mid] <= z: lo = mid
        else: hi = mid
    w = (z - Qrow[lo])/max(Qrow[hi]-Qrow[lo], 1e-12)
    return 1.0 - (lo + w)/(n-1)

@njit(cache=True)
def solve_budget_buy(ask0, lam, R, q):
    """largest q' <= q with q'(1-ask0) - 0.5 lam q'^2 <= R  (worst-case loss of a YES sale)."""
    if R <= 0: return 0.0
    A1 = 1.0 - ask0
    if A1 <= 0: return q
    disc = A1*A1 - 2*lam*R
    if disc >= 0:
        qm = (A1 - math.sqrt(disc))/lam
        if q > qm: q = qm
    return q

@njit(cache=True)
def solve_budget_sell(bid0, lam, R, q):
    """largest q' <= q with q' bid0 - 0.5 lam q'^2 <= R  (worst-case loss of a YES buy-back)."""
    if R <= 0: return 0.0
    if bid0 <= 0: return q
    disc = bid0*bid0 - 2*lam*R
    if disc >= 0:
        qm = (bid0 - math.sqrt(disc))/lam
        if q > qm: q = qm
    return q

@njit(cache=True)
def ladder_R(cm, ym, M, m, up):
    """R for the ladder: up (vault sells YES in market m) -> min_{j>m} W_j ; down -> min_{j<=m} W_j. W_j = sum c + sum_{i<j} y_i."""
    tot = 0.0
    for i in range(M): tot += cm[i]
    best = 1e18; W = tot
    for j in range(M+1):
        if j > 0: W += ym[j-1]
        if up:
            if j > m and W < best: best = W
        else:
            if j <= m and W < best: best = W
    return best

@njit(cache=True)
def oi_room(gross, lnKs, M, m, sdG, Qsafe):
    """max extra gross OI allowed in market m under the delta-weighted cap (checked at strikes and midpoints)."""
    room = 1e18
    for gi in range(2*M-1):
        if gi % 2 == 0: g = lnKs[gi//2]
        else: g = 0.5*(lnKs[gi//2] + lnKs[gi//2+1])
        S = 0.0
        for i in range(M):
            z = (g - lnKs[i])/sdG; S += gross[i]*math.exp(-0.5*z*z)
        z = (g - lnKs[m])/sdG; wt = math.exp(-0.5*z*z)
        if wt > 1e-9:
            r = (Qsafe - S)/wt
            if r < room: room = r
    return max(room, 0.0)

@njit(cache=True)
def run_series(t0s, lnK, tenor, cex, pool, sigH, sigA, ttab, Qtab, yidx, P, seed, out, stats, dvol, cum, Qsafe_arr,
               cgrid, cval, seasA):
    np.random.seed(seed)
    h0, cdl, gam0, clag, dtb = P[0], P[1], P[2], P[3], P[4]
    lam, cut, pmin, w, samp, dsy = P[5], int(P[6]), P[7], int(P[8]), int(P[9]), P[10]
    Bm, Bs, cmB, m_a, R = P[11], P[12], P[13], P[14], P[15]
    nq, npr = P[16], P[17]
    on = np.array([P[18] > 0, P[19] > 0, P[20] > 0, P[21] > 0, P[22] > 0])
    kid, nusc, rh, manip, stepy, blk = int(P[23]), P[24], P[25], P[26] > 0, P[27], int(P[28])
    m_lat, m_tail, m_dir, dstep, dpos, lamb = P[29], P[30], P[31], P[32], P[33], P[34]
    fixed, oi_on = P[35] > 0, P[36] > 0
    n = w // samp
    weff = dsy*(n-1)*(2*n-1)/(6*n)            # years
    nsteps = tenor - cut
    L, M = lnK.shape
    cm = np.zeros(M); ym = np.zeros(M); cA = np.zeros(M); yA = np.zeros(M); I = np.zeros(M); gross = np.zeros(M); pa = np.zeros(M); ng = np.zeros(M)
    for li in range(L):
        t0 = t0s[li]; T = t0 + tenor; yi = yidx[li]; Ks = lnK[li]
        cm[:] = 0.0; ym[:] = 0.0; cA[:] = 0.0; yA[:] = 0.0; I[:] = 0.0; gross[:] = 0.0; pa[:] = 0.0; ng[:] = 0.0
        ydir = np.zeros(M)
        volA = 0.0; volN = 0.0; volNreq = 0.0
        sig0 = sigH[t0]
        # settlement-window sd at the cutoff (for the OI cap) -- creation constant if sigma fixed
        vcut = sig0*sig0*((cut - w)*stepy + weff)
        sdG = math.sqrt(max(vcut, 1e-12))
        Qsafe = Qsafe_arr[li]
        # clairvoyant-vol pieces (window part), CEX 1-step squared returns
        Swin = 0.0; Swin_a = 0.0
        if on[3]:
            for i in range(T - w, T):
                r2 = cum[i+1] - cum[i]; wt = (T - 1 - i)/n if samp == 1 else ((T - 1 - i)//samp)/n
                Swin += r2*wt*wt; Swin_a += r2*wt
        nb = [0, 0, 0, 0, 0, 0]   # binding counters: band, qepoch, budget-market, ladder, oi, halted-steps
        for j in range(nsteps):
            t = t0 + j; hs = tenor - j
            sig = sig0 if fixed else sigH[t]
            s2 = sig*sig
            v = s2*((hs - w)*stepy + weff)
            a = 0.5*s2*((hs - w)*stepy + (n-1)*dsy/2)
            sd = math.sqrt(v)
            if blk > 1:
                xs = pool[t - (t % blk) - 1]
                if t % blk == 0: I[:] = 0.0
            else:
                xs = pool[t]; I[:] = 0.0
            gS = gam0 + clag*sig*math.sqrt(dtb)
            u_n = np.random.random(M); u_d = np.random.random(M)       # fixed number of draws per step (common random numbers)
            for m in range(M):
                K = Ks[m]
                Pm, dP = quote_core(kid, xs, K, a, sd, ttab, nusc, rh)
                ask = Pm + cdl*gS*dP + h0; bid = Pm - cdl*gS*dP - h0
                up_ok = (ask >= pmin) and (ask <= 1 - pmin)
                dn_ok = (bid >= pmin) and (bid <= 1 - pmin)
                if not up_ok and not dn_ok:
                    nb[5] += 1; continue
                if cmB > 0:
                    Qcap = R*m_a*cmB/max(dP, 1e-12)
                else:
                    Qcap = 1e18
                # ---------------- informed agent (only one class active per run)
                for ag in range(5):
                    if not on[ag]: continue
                    capq = 1e18
                    if ag == 0:
                        b, _ = quote_core(kid, cex[t], K, a, sd, ttab, nusc, rh); mg = m_lat
                    elif ag == 1:
                        sA = sigA[t]; vA = sA*sA*((hs - w)*stepy + weff)
                        bi = bucket_of(hs, BUCKETS_)
                        b = emp_p(-(cex[t] - K)/math.sqrt(vA), Qtab[yi, bi]); mg = m_tail
                    elif ag == 2:
                        sD = dvol[t]; vD = sD*sD*((hs - w)*stepy + weff); aD = 0.5*sD*sD*((hs - w)*stepy + (n-1)*dsy/2)
                        b = tab(XG_, ttab, (cex[t] - K - aD)/(math.sqrt(vD)*nusc)); mg = m_tail
                        if rh > 0: b, _ = quote_core(0, cex[t], K, aD, math.sqrt(vD), ttab, nusc, rh)
                    elif ag == 3:
                        vo = (cum[T - w] - cum[t]) + Swin; ao = 0.5*((cum[T - w] - cum[t]) + Swin_a)
                        b, _ = quote_core(0, cex[t], K, ao, math.sqrt(max(vo, 1e-12)), ttab, nusc, rh); mg = m_tail
                    else:
                        mu = 0.5*(cex[t] - cex[t - 1440])/1440.0
                        b, _ = quote_core(kid, cex[t] + mu*(hs - w/2), K, a, sd, ttab, nusc, rh); mg = m_dir
                        capq = dstep
                        if b > Pm: capq = min(capq, max(dpos - ydir[m], 0.0))
                        else: capq = min(capq, max(dpos + ydir[m], 0.0))
                    ask0 = ask + lam*I[m]; bid0 = bid + lam*I[m]
                    q = 0.0; cash = 0.0
                    if up_ok and (b - mg) > ask0:
                        q = ((b - mg) - ask0)/lam
                        if q > capq: q = capq
                        qb = (1 - pmin - ask0)/lam                      # band on marginal price
                        if q > qb: q = max(qb, 0.0); nb[0] += 1
                        qe = Qcap - I[m]                                  # per-epoch cap
                        if q > qe: q = max(qe, 0.0); nb[1] += 1
                        q1 = solve_budget_buy(ask0, lam, cm[m] + ym[m] + Bm, q)
                        if q1 < q: q = q1; nb[2] += 1
                        q1 = solve_budget_buy(ask0, lam, ladder_R(cm, ym, M, m, True) + Bs, q)
                        if q1 < q: q = q1; nb[3] += 1
                        if oi_on:
                            room = oi_room(gross, Ks, M, m, sdG, Qsafe)
                            lim = room + (max(-pa[m], 0.0))              # closing part is free
                            if q > lim: q = max(lim, 0.0); nb[4] += 1
                        if q > 0: cash = q*(ask0 + 0.5*lam*q)
                    elif dn_ok and (b + mg) < bid0:
                        q = (bid0 - (b + mg))/lam
                        if q > capq: q = capq
                        qb = (bid0 - pmin)/lam
                        if q > qb: q = max(qb, 0.0); nb[0] += 1
                        qe = Qcap + I[m]
                        if q > qe: q = max(qe, 0.0); nb[1] += 1
                        q1 = solve_budget_sell(bid0, lam, cm[m] + Bm, q)
                        if q1 < q: q = q1; nb[2] += 1
                        q1 = solve_budget_sell(bid0, lam, ladder_R(cm, ym, M, m, False) + Bs, q)
                        if q1 < q: q = q1; nb[3] += 1
                        if oi_on:
                            room = oi_room(gross, Ks, M, m, sdG, Qsafe)
                            lim = room + max(pa[m], 0.0)
                            if q > lim: q = max(lim, 0.0); nb[4] += 1
                        if q > 0: cash = q*(bid0 - 0.5*lam*q)
                        q = -q; cash = -cash
                    if q != 0.0:
                        cm[m] += cash; ym[m] -= q; cA[m] += cash; yA[m] -= q; I[m] += q; volA += abs(q)
                        g0 = abs(pa[m]); pa[m] += q; gross[m] += abs(pa[m]) - g0
                        if ag == 4: ydir[m] += q
                # ---------------- noise (one opening order of size nq with prob npr; own impact at per-block depth)
                if u_n[m] < npr:
                    volNreq += nq
                    buy = u_d[m] < 0.5
                    q = nq; Ib = I[m]/R
                    if buy and up_ok:
                        ask0 = ask + lamb*Ib
                        qb = (1 - pmin - ask0)/lamb
                        if q > qb: q = max(qb, 0.0)
                        qe = Qcap/R - Ib
                        if q > qe*R: q = max(qe*R, 0.0)             # order may be split over the R blocks of the step
                        q = solve_budget_buy(ask0, lamb, cm[m] + ym[m] + Bm, q)
                        q = solve_budget_buy(ask0, lamb, ladder_R(cm, ym, M, m, True) + Bs, q)
                        if oi_on: q = min(q, oi_room(gross, Ks, M, m, sdG, Qsafe))
                        if q > 0:
                            qc = min(q, max(Qcap/R, 1e-12))
                            cm[m] += q*(ask0 + 0.5*lamb*qc); ym[m] -= q; I[m] += q; volN += q; ng[m] += q; gross[m] += q
                    elif (not buy) and dn_ok:
                        bid0 = bid + lamb*Ib
                        qb = (bid0 - pmin)/lamb
                        if q > qb: q = max(qb, 0.0)
                        qe = Qcap/R + Ib
                        if q > qe*R: q = max(qe*R, 0.0)
                        q = solve_budget_sell(bid0, lamb, cm[m] + Bm, q)
                        q = solve_budget_sell(bid0, lamb, ladder_R(cm, ym, M, m, False) + Bs, q)
                        if oi_on: q = min(q, oi_room(gross, Ks, M, m, sdG, Qsafe))
                        if q > 0:
                            qc = min(q, max(Qcap/R, 1e-12))
                            cm[m] -= q*(bid0 - 0.5*lamb*qc); ym[m] += q; I[m] -= q; volN += q; ng[m] += q; gross[m] += q
        # ---------------- settlement: TWAP of pool over [T-w, T), one sample per `samp` steps (end of each block)
        G = 0.0
        for k in range(n):
            G += pool[T - w + (k+1)*samp - 1]
        G /= n
        # outcomes
        o = np.zeros(M)
        for m in range(M):
            if rh > 0: o[m] = min(max((G - Ks[m] + rh)/(2*rh), 0.0), 1.0)
            else: o[m] = 1.0 if G > Ks[m] else 0.0
        pnl0 = 0.0
        for m in range(M): pnl0 += cm[m] + ym[m]*o[m]
        pnl = pnl0; dstar = 0.0
        if manip:
            best = 0.0; bdir = 0; bd = 0.0
            for di in range(1, len(cgrid)):
                dl = cgrid[di]; cost = cval[di]
                for sgn in (1, -1):
                    gain = 0.0; lp = 0.0
                    for m in range(M):
                        if rh > 0:
                            o2 = min(max((G + sgn*dl - Ks[m] + rh)/(2*rh), 0.0), 1.0)
                        else:
                            o2 = 1.0 if (G + sgn*dl) > Ks[m] else 0.0
                        ch = ym[m]*(o2 - o[m])          # vault P&L change
                        if ch < 0: gain += -ch
                    if gain - cost > best: best = gain - cost; bdir = sgn; bd = dl
            if bdir != 0:
                pnl = 0.0
                for m in range(M):
                    if rh > 0: o2 = min(max((G + bdir*bd - Ks[m] + rh)/(2*rh), 0.0), 1.0)
                    else: o2 = 1.0 if (G + bdir*bd) > Ks[m] else 0.0
                    pnl += cm[m] + ym[m]*o2
                    o[m] = o2
                dstar = bd
        out[li, 0] = pnl; out[li, 1] = pnl0; out[li, 2] = volA; out[li, 3] = volN; out[li, 4] = volNreq
        out[li, 5] = dstar; out[li, 6] = gross.sum(); out[li, 7] = Qsafe
        wmin = 0.0; W = cm.sum()
        wmin = W
        for m in range(M):
            W += ym[m]
            if W < wmin: wmin = W
        out[li, 8] = wmin
        pa_ = 0.0
        for m in range(M): pa_ += cA[m] + yA[m]*o[m]
        out[li, 9] = pa_; out[li, 10] = pnl - pa_
        for k in range(6): stats[li, k] = nb[k]
