// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
/// Hart/West tail with 36-decimal Horner accumulators (coefficients x 1e18). Certified monotone (see report).
library HartTail36 {
    int256 internal constant WAD = 1e18;
    int256 internal constant SPLIT = 7071067811865470000;
    function num(int256 z) internal pure returns (int256 n) { unchecked {
        n = 35262496599891100000000000000000000;
        n = n * z / WAD + 700383064443688000000000000000000000;
        n = n * z / WAD + 6373962203531650000000000000000000000;
        n = n * z / WAD + 33912866078383000000000000000000000000;
        n = n * z / WAD + 112079291497871000000000000000000000000;
        n = n * z / WAD + 221213596169931000000000000000000000000;
        n = n * z / WAD + 220206867912376000000000000000000000000;
    } }
    function den(int256 z) internal pure returns (int256 d) { unchecked {
        d = 88388347648318400000000000000000000;
        d = d * z / WAD + 1755667163182640000000000000000000000;
        d = d * z / WAD + 16064177579207000000000000000000000000;
        d = d * z / WAD + 86780732202946100000000000000000000000;
        d = d * z / WAD + 296564248779674000000000000000000000000;
        d = d * z / WAD + 637333633378831000000000000000000000000;
        d = d * z / WAD + 793826512519948000000000000000000000000;
        d = d * z / WAD + 440413735824752000000000000000000000000;
    } }
    /// requires 0 <= z
    function tail(int256 z) internal pure returns (int256 c) { unchecked {
        if (z > 37 * WAD) return 0;
        int256 e = F.expWad(-(z * z / WAD / 2));
        if (z < SPLIT) {
            c = e * num(z) / den(z);
        } else {
            int256 f = z + WAD * WAD / (z + 2 * WAD * WAD / (z + 3 * WAD * WAD / (z + 4 * WAD * WAD / (z + 65 * WAD / 100))));
            c = e * WAD / (f * 2506628274631000502 / WAD);
        }
        if (c > WAD / 2) c = WAD / 2;
    } }
    function cdf(int256 x) internal pure returns (int256) { unchecked { return x <= 0 ? tail(-x) : WAD - tail(x); } }
}
