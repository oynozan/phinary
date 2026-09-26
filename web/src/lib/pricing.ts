/**
 * TypeScript port of src/math/BinaryPricer.sol (Gaussian kernel, r = 0).
 * Cash-or-nothing binary settled on a discrete geometric average over the final `window` seconds.
 * With Delta = window / n:
 *   mu = x - var/2 * (tau - w + (n-1)*Delta/2)
 *   v  = var * [(tau - w) + Delta*(n-1)*(2n-1)/(6n)]
 *   mid = Phi(mu / sqrt v)
 *   ask/bid = mid +/- (gammaS / sqrt v * phi(d)) +/- h0
 */

export const SECONDS_PER_YEAR = 31_557_600;

export const DEMO_QUOTE_PARAMS = {
    h0: 0.01,
    gammaS: 0.00002,
    pMin: 0.02,
} as const;

const SQRT_2PI = Math.sqrt(2 * Math.PI);

/** Standard normal CDF, Hart / West double-precision approximation. */
export function normCdf(x: number): number {
    const a = Math.abs(x);
    let c: number;
    if (a > 37) {
        c = 0;
    } else {
        const e = Math.exp((-a * a) / 2);
        if (a < 7.07106781186547) {
            let b = 3.52624965998911e-2 * a + 0.700383064443688;
            b = b * a + 6.37396220353165;
            b = b * a + 33.912866078383;
            b = b * a + 112.079291497871;
            b = b * a + 221.213596169931;
            b = b * a + 220.206867912376;
            c = e * b;
            b = 8.83883476483184e-2 * a + 1.75566716318264;
            b = b * a + 16.064177579207;
            b = b * a + 86.7807322029461;
            b = b * a + 296.564248779674;
            b = b * a + 637.333633378831;
            b = b * a + 793.826512519948;
            b = b * a + 440.413735824752;
            c = c / b;
        } else {
            let b = a + 0.65;
            b = a + 4 / b;
            b = a + 3 / b;
            b = a + 2 / b;
            b = a + 1 / b;
            c = e / b / SQRT_2PI;
        }
    }
    return x > 0 ? 1 - c : c;
}

export function normPdf(x: number): number {
    return Math.exp((-x * x) / 2) / SQRT_2PI;
}

/** Effective drift and variance times (seconds). n = 0 means continuous averaging. */
export function effectiveTimes(tau: number, window: number, n: number) {
    if (tau <= window) throw new Error("TooLate");
    const base = tau - window;
    if (n === 0) return { tDrift: base + window / 2, tVar: base + window / 3 };
    return {
        tDrift: base + (window * (n - 1)) / (2 * n),
        tVar: base + (window * (n - 1) * (2 * n - 1)) / (6 * n * n),
    };
}

export interface PriceResult {
    d: number;
    sqrtV: number;
    mid: number;
    pdf: number;
}

/**
 * @param x ln(S / K)
 * @param variance per-second variance
 * @param tau seconds to expiry (must exceed window)
 */
export function priceBinary(x: number, variance: number, tau: number, window: number, n: number): PriceResult {
    const { tDrift, tVar } = effectiveTimes(tau, window, n);
    const sqrtV = Math.sqrt(variance * tVar);
    if (sqrtV === 0) throw new Error("ZeroVariance");
    const mu = x - (variance * tDrift) / 2;
    const d = mu / sqrtV;
    return { d, sqrtV, mid: normCdf(d), pdf: normPdf(d) };
}

export function askBid(r: PriceResult, gammaS: number = DEMO_QUOTE_PARAMS.gammaS, h0: number = DEMO_QUOTE_PARAMS.h0) {
    const band = (gammaS / r.sqrtV) * r.pdf;
    const ask = Math.min(1, r.mid + band + h0);
    const bid = Math.max(0, r.mid - band - h0);
    return { ask, bid };
}

export function sigmaToVariance(sigmaAnnual: number): number {
    return (sigmaAnnual * sigmaAnnual) / SECONDS_PER_YEAR;
}

export function varianceToSigma(variancePerSecond: number): number {
    return Math.sqrt(variancePerSecond * SECONDS_PER_YEAR);
}

/** "What if ETH were at `spot`": mid probability of UP. */
export function midAt(spot: number, strike: number, variance: number, tau: number, window: number, n: number): number {
    return priceBinary(Math.log(spot / strike), variance, tau, window, n).mid;
}
