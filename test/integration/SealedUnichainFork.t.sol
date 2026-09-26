// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {SealedPoolOracle} from "../../src/oracle/SealedPoolOracle.sol";

/// @dev The subset of the deployed StateView lens this test checks the oracle against
interface IStateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
}

/// @notice Runs SealedPoolOracle against the real deep hookless ETH/USDC v4 pool on Unichain mainnet, proving the
///         no-external-oracle price source against live chain state instead of a local mock pool. Skipped when
///         UNICHAIN_RPC_URL is unset.
contract SealedUnichainForkTest is Test {
    IPoolManager internal constant POOL_MANAGER = IPoolManager(0x1F98400000000000000000000000000000000004);
    IStateView internal constant STATE_VIEW = IStateView(0x86e8631A016F9068C3f085fAF484Ee3F5fDee8f2);
    address internal constant USDC = 0x078D782b760474a361dDA0AF3839290b0EF57AD6;
    bytes32 internal constant DEEP_POOL_ID = 0x3258f413c7a88cda2fa8709a589d221a80f6574f63df5a5b6774485d8acc39d9;

    uint256 internal constant YEAR = 31_557_600;
    // ln comparison tolerance in WAD: the oracle applies lnWad twice (sqrtPrice, then squares by doubling), the
    // reference here applies it once to the squared ratio, so a few wei of fixed-point rounding drift is expected.
    int256 internal constant LN_TOL = 1_000;

    PoolKey internal key;
    SealedPoolOracle internal oracle;
    PoolSwapTest internal swapRouter;
    // Storage, not a local: solc's via-ir optimizer treats block.number as a pure, side-effect-free opcode and may
    // rematerialize a local copy of it at its later use, which silently picks up vm.roll's new value instead of the
    // one captured earlier. A storage slot forces a real read each time and is immune to that rematerialization.
    uint256 internal startBlock;

    receive() external payable {}

    function setUp() public {
        string memory rpc = vm.envOr("UNICHAIN_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "UNICHAIN_RPC_URL not set");
            return;
        }
        try vm.createSelectFork(rpc) {}
        catch {
            vm.skip(true, "Unichain RPC unreachable");
            return;
        }
        assertEq(block.chainid, 130, "not Unichain mainnet");

        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(USDC),
            fee: 500,
            tickSpacing: 10,
            hooks: IHooks(address(0))
        });
        assertEq(PoolId.unwrap(key.toId()), DEEP_POOL_ID, "key must reconstruct the deep pool's id");

        oracle = new SealedPoolOracle(
            POOL_MANAGER,
            key,
            int8(1), // sign: ETH is currency0
            int16(12), // decimalsShift: 18 (ETH) - 6 (USDC)
            uint32(1), // blockTime: 1 s per block on Unichain
            uint16(3), // maxStaleBlocks
            uint32(10), // gridSeconds
            uint16(180), // nWindows
            uint16(30), // minWindows
            uint32(100), // winsorTicks
            _varE36(0.2e18), // varMinE36
            _varE36(2.5e18), // varMaxE36
            _varE36(0.6e18), // fallbackVarE36
            uint16(4096) // cardinality
        );

        swapRouter = new PoolSwapTest(POOL_MANAGER);
    }

    function _varE36(uint256 sigmaAnnualWad) internal pure returns (uint256) {
        return sigmaAnnualWad * sigmaAnnualWad / YEAR;
    }

    /// @dev Human USD per ETH, WAD, from a raw sqrtPriceX96: independent of the oracle's own lnSpotSoBWad formula,
    ///      so this checks the oracle's output against the pool's real state rather than against itself.
    function _lnUsdPerEth(uint160 sqrtPriceX96) internal pure returns (int256) {
        uint256 usdWad = F.fullMulDiv(uint256(sqrtPriceX96) * 1e15, uint256(sqrtPriceX96) * 1e15, 1 << 192);
        return F.lnWad(int256(usdWad));
    }

    /// @notice Poke, roll 3 blocks with no chain activity in between (the fork's storage is frozen except for what
    ///         we do), poke again: the idle run seals and the start-of-block price matches StateView's slot0.
    function test_pokeSealsAgainstTheRealPoolAndMatchesStateView() public {
        assertFalse(oracle.poke(), "the first poke only takes a snapshot");
        startBlock = block.number;

        vm.roll(startBlock + 3);
        vm.warp(block.timestamp + 3);

        assertTrue(oracle.poke(), "three idle blocks on a frozen fork must seal");
        assertEq(oracle.frontier(), startBlock + 2, "frontier sits one block behind the sealing poke");

        (uint160 sp,,,) = STATE_VIEW.getSlot0(DEEP_POOL_ID);
        int256 expected = _lnUsdPerEth(sp);
        int256 got = oracle.lnSpotSoBWad();
        assertApproxEqAbs(got, expected, uint256(LN_TOL), "lnSpotSoBWad must match StateView's slot0");
    }

    /// @notice After the oracle is started, a real swap against the live pool changes its fee growth (and usually
    ///         its price), so the next poke must not seal: no value the oracle returns can be moved by a swap
    ///         executed earlier in the block it is read in.
    function test_swapOnTheRealPoolBreaksTheSeal() public {
        oracle.poke();
        vm.roll(block.number + 3);
        vm.warp(block.timestamp + 3);
        assertTrue(oracle.poke(), "starts the oracle on an idle run");
        uint256 frontierBefore = oracle.frontier();
        (uint160 spBefore,,,) = STATE_VIEW.getSlot0(DEEP_POOL_ID);

        vm.deal(address(this), 30 ether);
        swapRouter.swap{value: 25 ether}(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -25 ether,
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        (uint160 spAfter,,,) = STATE_VIEW.getSlot0(DEEP_POOL_ID);
        assertTrue(spAfter != spBefore, "the swap must move the pool's price");

        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 1);
        assertFalse(oracle.poke(), "a swap inside the run must break the seal");
        assertEq(oracle.frontier(), frontierBefore, "frontier holds while the run is broken");
    }
}
