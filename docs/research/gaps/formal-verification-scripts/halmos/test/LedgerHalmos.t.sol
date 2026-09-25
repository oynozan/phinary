// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {VcsModel} from "../src/VcsModel.sol";
import {Ladder} from "../src/Ladder.sol";

contract VcsHarness is VcsModel {
    function set(uint256 id, uint256 b, uint256 oy, uint256 on, uint256 iy, uint256 in_, bool res, bool yw) external {
        m[id] = M(b, oy, on, iy, in_, res, yw);
    }
    function setGlobal(uint256 i, uint256 c) external { idle = i; claims = c; }
    function S3(uint256 id) public view returns (bool) {
        M storage x = m[id];
        uint256 req = x.resolved ? (x.yesWon ? x.outY : x.outN) : (x.outY > x.outN ? x.outY : x.outN);
        return x.bucket >= req;
    }
    function S4() public view returns (bool) { return m[0].bucket + m[1].bucket + idle == claims; }
}

contract LedgerHalmos is Test {
    VcsHarness h;
    function setUp() public { h = new VcsHarness(); }

    function _init(uint256 b0, uint256 y0, uint256 n0, uint256 b1, uint256 idle) internal {
        vm.assume(b0 < 2**128 && y0 < 2**128 && n0 < 2**128 && b1 < 2**128 && idle < 2**128);
        vm.assume(b0 >= (y0 > n0 ? y0 : n0));
        h.set(0, b0, y0, n0, 0, 0, false, false);
        h.set(1, b1, 0, 0, 0, 0, false, false);
        h.setGlobal(idle, b0 + b1 + idle);
    }
    // Inductive step for S3 and S4 over ALL 8 swap cases with the price layer abstracted (q, cash arbitrary)
    function check_S3S4_swapAbs(uint256 b0, uint256 y0, uint256 n0, uint256 b1, uint256 idle,
                                bool isYes, bool buying, uint256 q, uint256 cash) public {
        _init(b0, y0, n0, b1, idle);
        vm.assume(q < 2**128 && cash < 2**128);
        try h.swapAbs(0, isYes, buying, q, cash) {} catch {}
        assert(h.S3(0) && h.S3(1) && h.S4());
    }
    // Same, with the real amount layer: 8 cases x FullMath 512-bit mulDiv / mulDivRoundingUp
    function check_S3S4_swapReal(uint256 b0, uint256 y0, uint256 n0, uint256 b1, uint256 idle,
                                 bool isYes, bool buying, bool exactIn, uint256 a, uint256 ask, uint256 bid) public {
        _init(b0, y0, n0, b1, idle);
        vm.assume(a < 2**64 && ask > 0 && ask < 1e18 && bid > 0 && bid <= ask);
        try h.swap(0, isYes, buying, exactIn, a, ask, bid) {} catch {}
        assert(h.S3(0) && h.S3(1) && h.S4());
    }
    function check_S3S4_otherOps(uint256 b0, uint256 y0, uint256 n0, uint256 b1, uint256 idle, uint8 op, uint256 amt, bool yw) public {
        _init(b0, y0, n0, b1, idle);
        vm.assume(amt < 2**128);
        if (op == 0) try h.split(0, amt) {} catch {}
        else if (op == 1) try h.merge(0, amt) {} catch {}
        else if (op == 2) try h.fund(0, amt) {} catch {}
        else if (op == 3) try h.defund(0, amt) {} catch {}
        else if (op == 4) try h.deposit(amt) {} catch {}
        else if (op == 5) try h.withdraw(amt) {} catch {}
        else if (op == 6) try h.resolve(0, yw) {} catch {}
        assert(h.S3(0) && h.S3(1) && h.S4());
    }
    function check_S3S4_redeem(uint256 b0, uint256 y0, uint256 n0, uint256 b1, uint256 idle, bool yw, uint256 amt) public {
        vm.assume(b0 < 2**128 && y0 < 2**128 && n0 < 2**128 && b1 < 2**128 && idle < 2**128 && amt < 2**128);
        vm.assume(b0 >= (yw ? y0 : n0));
        h.set(0, b0, y0, n0, 0, 0, true, yw);
        h.set(1, b1, 0, 0, 0, 0, false, false);
        h.setGlobal(idle, b0 + b1 + idle);
        try h.redeem(0, amt) {} catch {}
        assert(h.S3(0) && h.S4());
    }

    // Ladder prefix pass == brute force over all n+1 settlement regions (n = 3 and n = 4)
    function check_ladder3(uint64 cash, uint64 y0, uint64 y1, uint64 y2, uint64 n0, uint64 n1, uint64 n2) public pure {
        uint128[] memory Y = new uint128[](3); uint128[] memory N = new uint128[](3);
        Y[0] = y0; Y[1] = y1; Y[2] = y2; N[0] = n0; N[1] = n1; N[2] = n2;
        int256 mn = Ladder.ladderMin(cash, Y, N);
        bool hit;
        for (uint256 j; j <= 3; ++j) {
            int256 w = Ladder.wealth(cash, Y, N, j);
            assert(mn <= w);
            if (mn == w) hit = true;
        }
        assert(hit);
    }
    function check_ladder4(uint64 cash, uint64 y0, uint64 y1, uint64 y2, uint64 y3, uint64 n0, uint64 n1, uint64 n2, uint64 n3) public pure {
        uint128[] memory Y = new uint128[](4); uint128[] memory N = new uint128[](4);
        Y[0] = y0; Y[1] = y1; Y[2] = y2; Y[3] = y3; N[0] = n0; N[1] = n1; N[2] = n2; N[3] = n3;
        int256 mn = Ladder.ladderMin(cash, Y, N);
        bool hit;
        for (uint256 j; j <= 4; ++j) {
            int256 w = Ladder.wealth(cash, Y, N, j);
            assert(mn <= w);
            if (mn == w) hit = true;
        }
        assert(hit);
    }
    // union bound <= exact min (fast path is sound)
    function check_unionBound3(uint64 cash, uint64 y0, uint64 y1, uint64 y2, uint64 n0, uint64 n1, uint64 n2) public pure {
        uint128[] memory Y = new uint128[](3); uint128[] memory N = new uint128[](3);
        Y[0] = y0; Y[1] = y1; Y[2] = y2; N[0] = n0; N[1] = n1; N[2] = n2;
        int256 lb = int256(uint256(cash)) + int256(uint256(y0 < n0 ? y0 : n0)) + int256(uint256(y1 < n1 ? y1 : n1)) + int256(uint256(y2 < n2 ? y2 : n2));
        assert(lb <= Ladder.ladderMin(cash, Y, N));
    }
}
