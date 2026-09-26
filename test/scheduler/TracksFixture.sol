// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {PredictionHook} from "../../src/PredictionHook.sol";
import {MarketGatekeeper} from "../../src/MarketGatekeeper.sol";
import {MarketScheduler} from "../../src/MarketScheduler.sol";
import {IMarketGatekeeper} from "../../src/interfaces/IMarketGatekeeper.sol";
import {IPredictionHook} from "../../src/interfaces/IPredictionHook.sol";
import {IMarketScheduler} from "../../src/interfaces/IMarketScheduler.sol";
import {MockOracle} from "../hook/mocks/MockOracle.sol";
import {MockUSDC} from "../hook/mocks/MockUSDC.sol";

/// @dev A track with the demo quote and budgets (max 10, min 1 USDC) and `tenor == period`
function trackConfig(uint32 period, uint32 window, uint32 nSamples, string memory ticker)
    pure
    returns (IMarketScheduler.Config memory c)
{
    c.period = period;
    c.tenor = period;
    c.window = window;
    c.cutoffBuffer = 2;
    c.nSamples = nSamples;
    c.quote = IPredictionHook.QuoteParams({
        h0Wad: 0.02e18, gammaSWad: 0.00002e18, lambdaWad: 0.001e18, qEpochMax: 100e6, pMinWad: 0.02e18
    });
    c.maxBudget = 10e6;
    c.minBudget = 1e6;
    c.ticker = ticker;
}

function track1m() pure returns (IMarketScheduler.Config memory) {
    return trackConfig(60, 10, 10, "ETH");
}

function track15m() pure returns (IMarketScheduler.Config memory) {
    return trackConfig(900, 30, 30, "ETH15M");
}

/// @dev The live track list, in gatekeeper order
function demoTracks() pure returns (IMarketScheduler.Config[] memory cs) {
    cs = new IMarketScheduler.Config[](2);
    cs[0] = track1m();
    cs[1] = track15m();
}

function solTrack() pure returns (IMarketScheduler.Config memory) {
    return trackConfig(60, 10, 10, "SOL");
}

/// @dev Every config behind the one oracle `o`
function withOracle(address o, IMarketScheduler.Config[] memory cs) pure returns (IMarketGatekeeper.Track[] memory ts) {
    ts = new IMarketGatekeeper.Track[](cs.length);
    for (uint256 i; i < cs.length; ++i) {
        ts[i] = IMarketGatekeeper.Track({oracle: o, config: cs[i]});
    }
}

/// @notice One PoolManager, ETH oracle (spot exactly $2690.13) and SOL oracle (spot exactly $187.42) shared by every hook and gatekeeper the tests deploy;
///         each set gets its own hook address (permission bits in the low bits, a bumped salt in the high bits) and
///         its own USDC so idle balances stay under test control.
abstract contract TracksFixture is Test, Deployers {
    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_REMOVE_LIQUIDITY_FLAG
            | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.BEFORE_DONATE_FLAG
    );
    uint256 internal constant E6 = 1e6;
    /// @dev 26 Sep 2026 14:00:00 UTC, a quarter-hour boundary
    uint256 internal constant T0 = 1_790_431_200;

    MockOracle internal oracle;
    MockOracle internal solOracle;
    uint160 internal _hookSalt = 0x4444;

    function _setUpShared() internal {
        vm.warp(T0);
        deployFreshManagerAndRouters();
        oracle = new MockOracle();
        oracle.setLnSpot(F.lnWad(2690.13e18));
        solOracle = new MockOracle();
        solOracle.setLnSpot(F.lnWad(187.42e18));
    }

    /// @dev A hook address with the permission bits, not yet used by any earlier set
    function _nextHookAddr() internal returns (address hookAddr) {
        hookAddr = address(FLAGS | (_hookSalt << 144));
        _hookSalt += 1;
    }

    /// @dev Fresh USDC, then the gatekeeper and last the hook, in the live deploy order: the gatekeeper and its
    ///      schedulers are built against a hook address that has no code yet, so a constructor that called the hook
    ///      would revert here
    function _deployTracks(IMarketGatekeeper.Track[] memory ts)
        internal
        returns (MockUSDC u, PredictionHook h, MarketGatekeeper g)
    {
        u = new MockUSDC();
        address hookAddr = _nextHookAddr();
        require(hookAddr.code.length == 0, "hook address already has code");
        g = new MarketGatekeeper(IPredictionHook(hookAddr), ts);
        deployCodeTo("src/PredictionHook.sol:PredictionHook", abi.encode(manager, address(u), address(g)), hookAddr);
        h = PredictionHook(hookAddr);
    }

    /// @dev Every track behind the shared ETH oracle
    function _deployTracks(IMarketScheduler.Config[] memory cs)
        internal
        returns (MockUSDC u, PredictionHook h, MarketGatekeeper g)
    {
        return _deployTracks(withOracle(address(oracle), cs));
    }

    /// @dev External so an expectRevert applies to this call, since forge turns `new` in a test into a deployCode
    ///      cheatcode whose expected revert would otherwise end the test early
    function deployGatekeeper(IPredictionHook h, IMarketGatekeeper.Track[] memory ts)
        external
        returns (MarketGatekeeper)
    {
        return new MarketGatekeeper(h, ts);
    }

    /// @dev External for the same reason as `deployGatekeeper`
    function deployScheduler(IPredictionHook h, IMarketGatekeeper g, address o, IMarketScheduler.Config memory c)
        external
        returns (MarketScheduler)
    {
        return new MarketScheduler(h, g, o, c);
    }

    function _one(IMarketScheduler.Config memory c) internal pure returns (IMarketScheduler.Config[] memory cs) {
        cs = new IMarketScheduler.Config[](1);
        cs[0] = c;
    }

    function _deposit(PredictionHook h, MockUSDC u, address who, uint256 amt) internal {
        u.mint(who, amt);
        vm.startPrank(who);
        u.approve(address(h), amt);
        h.deposit(amt);
        vm.stopPrank();
    }
}
