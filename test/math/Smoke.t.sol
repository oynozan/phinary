// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {BinaryPricer} from "../../src/math/BinaryPricer.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";

contract SmokeTest is Test, Deployers {
    function test_aliceExampleMid() public pure {
        // S=2700, K=2800, sigma=60%/yr, tau=24h, w=4h, continuous averaging -> mid ~= 0.1068 (python example)
        int256 x = F.lnWad(2700e18) - F.lnWad(2800e18);
        uint256 varE36 = uint256(0.36e36) / 31557600;
        BinaryPricer.Result memory r = BinaryPricer.price(x, varE36, 24 hours, 4 hours, 0);
        assertApproxEqAbs(r.mid, 0.1068e18, 0.0005e18);
        (uint256 ask, uint256 bid) = BinaryPricer.askBid(r, 0.00055e18, 0.02e18);
        assertGt(ask, r.mid);
        assertLt(bid, r.mid);
    }

    function test_v4Deploys() public {
        deployFreshManagerAndRouters();
        assertTrue(address(manager) != address(0));
    }
}
