// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
/// Memory version of lp-vault-scripts/src/SeriesHook.sol::ladderMin (same arithmetic), strikes sorted ascending.
library Ladder {
    function ladderMin(uint256 cash, uint128[] memory invY, uint128[] memory invN) internal pure returns (int256 mn) {
        uint256 n = invY.length;
        int256 run = int256(cash);
        for (uint256 i; i < n; ++i) run += int256(uint256(invN[i]));
        mn = run;
        for (uint256 i; i < n; ++i) {
            run += int256(uint256(invY[i])) - int256(uint256(invN[i]));
            if (run < mn) mn = run;
        }
    }
    /// brute-force spec: terminal wealth in region j = cash + sum_{i<j} invY_i + sum_{i>=j} invN_i
    function wealth(uint256 cash, uint128[] memory invY, uint128[] memory invN, uint256 j) internal pure returns (int256 w) {
        w = int256(cash);
        for (uint256 i; i < invY.length; ++i) w += int256(uint256(i < j ? invY[i] : invN[i]));
    }
}
