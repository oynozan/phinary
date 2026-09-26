// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import {V3ObserveAdapter, IUniswapV3PoolOracle} from "../src/V3ObserveAdapter.sol";
import {VolOracleV2} from "../src/VolOracleV2.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

interface IV3Swap {
    function swap(address, bool, int256, uint160, bytes calldata) external returns (int256, int256);
}

interface IERC20 {
    function transfer(address, uint256) external returns (bool);
}

/// Mainnet fork against the Uniswap v3 USDC/WETH 5 bp pool (token0 = USDC -> ETH up = tick down -> sign -1).
contract ForkV3Test is Test {
    address constant POOL = 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640;
    address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    uint32 constant H = 300;
    V3ObserveAdapter ad;
    bytes32 feed;

    function setUp() public {
        vm.createSelectFork("mainnet");
        ad = new V3ObserveAdapter(POOL, true, 12, H, 400, 4096, 120);
        feed = bytes32(uint256(uint160(POOL)));
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata) external {
        if (a0 > 0) IERC20(USDC).transfer(msg.sender, uint256(a0));
        if (a1 > 0) IERC20(WETH).transfer(msg.sender, uint256(a1));
    }

    function _push(bool ethDown, uint256 amt) internal {
        // ethDown: sell WETH (token1) for USDC -> zeroForOne = false? price token1/token0... tick = log(WETH per USDC)
        // selling WETH raises WETH-per-USDC -> tick up -> normalized (ETH) tick down.
        if (ethDown) {
            deal(WETH, address(this), amt);
            IV3Swap(POOL).swap(address(this), false, int256(amt), 1461446703485210103287273052203988822378723970341, "");
        } else {
            deal(USDC, address(this), amt);
            IV3Swap(POOL).swap(address(this), true, int256(amt), 4295128740, "");
        }
    }

    function test_fork_sobAndSameBlockInvariance() public {
        (, int24 raw,,,,,) = IUniswapV3PoolOracle(POOL).slot0();
        (int24 sob, uint32 lw) = ad.sobTick(feed);
        emit log_named_uint("fork block", block.number);
        emit log_named_int("raw slot0 tick", raw);
        emit log_named_int("normalized SoB tick", sob);
        emit log_named_uint("last v3 write", lw);
        if (lw != uint32(block.timestamp)) assertEq(sob, -raw, "no write this block -> SoB == -slot0.tick");
        // ETH price sanity: 1.0001^sob * 1e12 in [$500, $20000]  <=>  sob in [-214,000, -175,000]
        assertGt(sob, -214_000);
        assertLt(sob, -175_000);
        int56 c0 = ad.cumulativeNow(feed);
        (uint160 p0, bool ex0) = ad.sobSqrtPriceX96(feed);
        // manipulate: dump 3,000 WETH into the pool in this block (moves several ticks), then read again
        _push(true, 3_000 ether);
        (, int24 raw2,,,,,) = IUniswapV3PoolOracle(POOL).slot0();
        (int24 sob2,) = ad.sobTick(feed);
        emit log_named_int("raw slot0 tick after 3000 WETH dump", raw2);
        assertTrue(raw2 != raw, "manipulation moved the pool");
        assertEq(sob2, sob, "SoB unchanged by same-block swap");
        (uint160 p1, bool ex1) = ad.sobSqrtPriceX96(feed);
        if (ex0) {
            // before: exact live price; after the v3 write only the tick is known -> midpoint of the same tick
            assertFalse(ex1);
            assertEq(int256(TickMath.getTickAtSqrtPrice(p1)), int256(TickMath.getTickAtSqrtPrice(p0)), "SoB price stays in the SoB tick");
        } else {
            assertEq(p1, p0);
        }
        assertEq(ad.cumulativeNow(feed), c0, "cumulativeNow unchanged by same-block swap");
        _push(false, 20_000_000e6);
        (int24 sob3,) = ad.sobTick(feed);
        assertEq(sob3, sob, "SoB unchanged after push back");
    }

    function test_fork_pokeAndRealizedVol() public {
        uint32 n = ad.poke();
        (uint32 lastGrid, uint32 nWin,,,,,) = ad.st();
        emit log_named_uint("checkpoints written by first poke", n);
        emit log_named_uint("window differences measured", nWin);
        assertGt(nWin, 20);
        // independent recomputation straight from v3 observe()
        uint32 gA = lastGrid - nWin - 1;
        uint32 m = lastGrid - gA + 1;
        uint32[] memory ago = new uint32[](m);
        for (uint32 i; i < m; i++) ago[i] = uint32(block.timestamp) - (gA + i) * H;
        (int56[] memory cums,) = IUniswapV3PoolOracle(POOL).observe(ago);
        uint256 dq;
        int256 prevD;
        for (uint32 i = 1; i < m; i++) {
            int256 D = -(int256(cums[i]) - int256(cums[i - 1]));
            if (i > 1) {
                int256 d = D - prevD;
                if (d > 400 * 300) d = 400 * 300;
                if (d < -400 * 300) d = -400 * 300;
                dq += uint256(d * d);
            }
            prevD = D;
        }
        (uint256 v, uint32 s, uint32 e, uint32 dN) = ad.varianceE36(feed, nWin);
        assertEq(e, lastGrid);
        assertEq(s, lastGrid - nWin);
        assertEq(dN, nWin);
        assertEq(v, VolOracleV2.mulDiv(dq * 3, VolOracleV2.LN_TICK_SQ_E36, 2 * uint256(H) ** 3 * dN), "bit-exact vs direct observe()");
        uint256 annualVarWad = v * 31_536_000 / 1e18;
        emit log_named_decimal_uint("sigma_hat^2 annual (TWAP-return, H=300, raw)", annualVarWad, 18);
        emit log_named_uint("hours covered", uint256(dN) * H / 3600);
        // settlement read path: cumulative at two grid times, normalized
        int56 cA = ad.cumulativeAtGrid(feed, lastGrid - 6);
        int56 cB = ad.cumulativeAtGrid(feed, lastGrid);
        int256 meanTick = (int256(cB) - int256(cA)) / int256(uint256(6 * H));
        emit log_named_int("30-min mean normalized tick (settlement-style)", meanTick);
        // continuity: advance 7 minutes with swaps, poke again -> exactly one or two more windows, chain kept
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 12);
        _push(true, 50 ether);
        vm.roll(block.number + 35);
        vm.warp(block.timestamp + 420);
        _push(false, 100_000e6);
        uint32 n2 = ad.poke();
        (uint32 lastGrid2, uint32 nWin2,,,,,) = ad.st();
        assertEq(nWin2 - nWin, lastGrid2 - lastGrid, "no chain break");
        assertGt(n2, 0);
    }
}
