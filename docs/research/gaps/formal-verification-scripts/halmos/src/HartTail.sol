// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
/// Verbatim copy of docs/research/05-math-scripts/evm/T.sol::tail (checked arithmetic), split into stages
library HartTail {
    int256 internal constant WAD = 1e18;
    int256 internal constant SPLIT = 7071067811865470000;
    function num(int256 z) internal pure returns (int256 n) {
        n = 35262496599891100;
        n = n * z / WAD + 700383064443688000; n = n * z / WAD + 6373962203531650000; n = n * z / WAD + 33912866078383000000;
        n = n * z / WAD + 112079291497871000000; n = n * z / WAD + 221213596169931000000; n = n * z / WAD + 220206867912376000000;
    }
    function den(int256 z) internal pure returns (int256 d) {
        d = 88388347648318400;
        d = d * z / WAD + 1755667163182640000; d = d * z / WAD + 16064177579207000000; d = d * z / WAD + 86780732202946100000;
        d = d * z / WAD + 296564248779674000000; d = d * z / WAD + 637333633378831000000; d = d * z / WAD + 793826512519948000000;
        d = d * z / WAD + 440413735824752000000;
    }
    function expo(int256 z) internal pure returns (int256) { return F.expWad(-(z * z / WAD / 2)); }
    function tail(int256 z) internal pure returns (int256 c) {
        if (z > 37 * WAD) return 0;
        int256 e = expo(z);
        if (z < SPLIT) {
            c = e * num(z) / den(z);
        } else {
            int256 f = z + WAD * WAD / (z + 2 * WAD * WAD / (z + 3 * WAD * WAD / (z + 4 * WAD * WAD / (z + 65 * WAD / 100))));
            c = e * WAD / (f * 2506628274631000502 / WAD);
        }
        if (c > WAD / 2) c = WAD / 2;
    }
}
