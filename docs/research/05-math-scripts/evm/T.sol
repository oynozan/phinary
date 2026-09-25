// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {Gaussian} from "solstat/Gaussian.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
contract T {
    int256 constant WAD = 1e18;
    function cdf(int256 x) external pure returns (int256) { return Gaussian.cdf(x); }
    function expWad(int256 x) external pure returns (int256) { return F.expWad(x); }
    function lnWad(int256 x) external pure returns (int256) { return F.lnWad(x); }
    // Hart/West WAD port mirroring 02b_monotone.py::hart_cdf
    function tail(int256 z) public pure returns (int256 c) {
        if (z > 37 * WAD) return 0;
        int256 e = F.expWad(-(z * z / WAD / 2));
        if (z < 7071067811865470000) {
            int256 n = 35262496599891100;
            n = n * z / WAD + 700383064443688000; n = n * z / WAD + 6373962203531650000; n = n * z / WAD + 33912866078383000000;
            n = n * z / WAD + 112079291497871000000; n = n * z / WAD + 221213596169931000000; n = n * z / WAD + 220206867912376000000;
            int256 d = 88388347648318400;
            d = d * z / WAD + 1755667163182640000; d = d * z / WAD + 16064177579207000000; d = d * z / WAD + 86780732202946100000;
            d = d * z / WAD + 296564248779674000000; d = d * z / WAD + 637333633378831000000; d = d * z / WAD + 793826512519948000000;
            d = d * z / WAD + 440413735824752000000;
            c = e * n / d;
        } else {
            int256 f = z + WAD * WAD / (z + 2 * WAD * WAD / (z + 3 * WAD * WAD / (z + 4 * WAD * WAD / (z + 65 * WAD / 100))));
            c = e * WAD / (f * 2506628274631000502 / WAD);
        }
        if (c > WAD / 2) c = WAD / 2;
    }
    function tailU(int256 z) public pure returns (int256 c) { unchecked {
        if (z > 37 * WAD) return 0;
        int256 e = F.expWad(-(z * z / WAD / 2));
        if (z < 7071067811865470000) {
            int256 n = 35262496599891100;
            n = n * z / WAD + 700383064443688000; n = n * z / WAD + 6373962203531650000; n = n * z / WAD + 33912866078383000000;
            n = n * z / WAD + 112079291497871000000; n = n * z / WAD + 221213596169931000000; n = n * z / WAD + 220206867912376000000;
            int256 d = 88388347648318400;
            d = d * z / WAD + 1755667163182640000; d = d * z / WAD + 16064177579207000000; d = d * z / WAD + 86780732202946100000;
            d = d * z / WAD + 296564248779674000000; d = d * z / WAD + 637333633378831000000; d = d * z / WAD + 793826512519948000000;
            d = d * z / WAD + 440413735824752000000;
            c = e * n / d;
        } else {
            int256 f = z + WAD * WAD / (z + 2 * WAD * WAD / (z + 3 * WAD * WAD / (z + 4 * WAD * WAD / (z + 65 * WAD / 100))));
            c = e * WAD / (f * 2506628274631000502 / WAD);
        }
        if (c > WAD / 2) c = WAD / 2;
    } }
    function hart(int256 x) public pure returns (int256) { return x <= 0 ? tail(-x) : WAD - tail(x); }
    function hartU(int256 x) public pure returns (int256) { unchecked { return x <= 0 ? tailU(-x) : WAD - tailU(x); } }
    function hartUGas(int256 x) external view returns (int256 r, uint256 g) { g = gasleft(); r = hartU(x); g = g - gasleft(); }
    function quote(uint256 S, uint256 K, uint256 sig, uint256 tau) public pure returns (int256) {
        int256 v = int256(F.mulWad(sig, F.sqrtWad(tau)));
        int256 d2 = (F.lnWad(int256(F.divWad(S, K))) - int256(F.mulWad(sig, sig) * tau / 2e18)) * WAD / v;
        return hartU(d2);
    }
    function quoteGas(uint256 S, uint256 K, uint256 sig, uint256 tau) external view returns (int256 r, uint256 g) { g = gasleft(); r = quote(S,K,sig,tau); g = g - gasleft(); }
    function hartGas(int256 x) external view returns (int256 r, uint256 g) { g = gasleft(); r = hart(x); g = g - gasleft(); }
    function cdfGas(int256 x) external view returns (int256 r, uint256 g) { g = gasleft(); r = Gaussian.cdf(x); g = g - gasleft(); }
    function lnGas(int256 x) external view returns (int256 r, uint256 g) { g = gasleft(); r = F.lnWad(x); g = g - gasleft(); }
    // hart monotonicity scan: returns number of decreases in n consecutive steps of size step
    function scan(int256 start, int256 step, uint256 n) external pure returns (uint256 viol, int256 maxDrop) {
        int256 prev = hart(start);
        for (uint256 i = 1; i <= n; i++) { int256 cur = hart(start + int256(i) * step); if (cur < prev) { viol++; if (prev - cur > maxDrop) maxDrop = prev - cur; } prev = cur; }
    }
}
