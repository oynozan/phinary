// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {Withdraw} from "../../script/Withdraw.s.sol";
import {MarketGatekeeper} from "../../src/MarketGatekeeper.sol";
import {PredictionHook} from "../../src/PredictionHook.sol";
import {IMarketGatekeeper} from "../../src/interfaces/IMarketGatekeeper.sol";
import {IMarketScheduler} from "../../src/interfaces/IMarketScheduler.sol";
import {IPredictionHook} from "../../src/interfaces/IPredictionHook.sol";
import {MockOracle} from "../hook/mocks/MockOracle.sol";
import {MockUSDC} from "../hook/mocks/MockUSDC.sol";
import {demoConfig} from "./DeployTracks.t.sol";

contract WithdrawHarness is Withdraw {
    address internal immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function _startBroadcast() internal override returns (address) {
        vm.startBroadcast(signer);
        return signer;
    }

    function withdrawAt(string memory path, address hook) external returns (uint256) {
        return _withdraw(vm.readFile(path), path, hook);
    }
}

/// @notice Withdraw against a gatekeeper-owned hook on a local PoolManager
contract WithdrawTest is Test, Deployers {
    address internal lp = makeAddr("lp");
    MockUSDC internal usdc;
    PredictionHook internal hook;
    IMarketScheduler internal scheduler;
    WithdrawHarness internal script;
    string internal dir;

    function setUp() public {
        vm.warp(1_790_400_000);
        deployFreshManagerAndRouters();
        usdc = new MockUSDC();
        MockOracle oracle = new MockOracle();
        oracle.setLnSpot(F.lnWad(2690.13e18));
        address h = address(uint160(0x2AA8) | (uint160(0x5555) << 144));
        IMarketGatekeeper.Track[] memory tracks = new IMarketGatekeeper.Track[](1);
        tracks[0] = IMarketGatekeeper.Track(address(oracle), demoConfig("ETH", 60, 10));
        MarketGatekeeper g = new MarketGatekeeper(IPredictionHook(h), tracks);
        deployCodeTo("src/PredictionHook.sol:PredictionHook", abi.encode(manager, address(usdc), address(g)), h);
        hook = PredictionHook(h);
        scheduler = IMarketScheduler(g.schedulers()[0]);
        usdc.mint(lp, 100e6);
        vm.startPrank(lp);
        usdc.approve(h, 100e6);
        hook.deposit(100e6);
        vm.stopPrank();
        script = new WithdrawHarness(lp);
        dir = string.concat(vm.projectRoot(), "/deployments/.run/test");
        vm.createDir(dir, true);
    }

    function _seed(string memory name, string memory body) internal returns (string memory path) {
        path = string.concat(dir, "/withdraw-", name, ".json");
        vm.writeFile(path, string.concat('{"chainId":', vm.toString(block.chainid), body, "}"));
    }

    function test_withdrawsEveryShareOfTheSigner() public {
        string memory path = _seed("current", string.concat(',"predictionHook":"', vm.toString(address(hook)), '"'));

        uint256 assets = script.withdrawAt(path, address(hook));

        assertEq(hook.sharesOf(lp), 0, "no shares left");
        assertEq(usdc.balanceOf(lp), assets, "USDC back to the signer");
        assertApproxEqAbs(assets, 100e6, 1, "the whole deposit, up to 1 unit of rounding");
        vm.removeFile(path);
    }

    function test_acceptsALegacyHook() public {
        string memory path = _seed(
            "legacy",
            string.concat(',"predictionHook":"0x000000000000000000000000000000000000dEaD","legacyPredictionHooks":["', vm.toString(address(hook)), '"]')
        );

        script.withdrawAt(path, address(hook));

        assertEq(hook.sharesOf(lp), 0);
        vm.removeFile(path);
    }

    function test_refusesAHookWithAnOpenMarket() public {
        string memory path = _seed("open", string.concat(',"predictionHook":"', vm.toString(address(hook)), '"'));
        scheduler.open();

        vm.expectRevert(
            bytes("hook is not drained, navMinus 100.000000 USDC but vaultIdle 90.000000 USDC, settle and sweep its markets first")
        );
        script.withdrawAt(path, address(hook));
        vm.removeFile(path);
    }

    function test_refusesAHookTheFileDoesNotName() public {
        string memory path = _seed("unknown", ',"predictionHook":"0x000000000000000000000000000000000000dEaD"');
        vm.expectRevert(bytes("WITHDRAW_HOOK is neither predictionHook nor in legacyPredictionHooks"));
        script.withdrawAt(path, address(hook));
        vm.removeFile(path);
    }

    function test_refusesASignerWithoutShares() public {
        string memory path = _seed("no-shares", string.concat(',"predictionHook":"', vm.toString(address(hook)), '"'));
        script.withdrawAt(path, address(hook));
        vm.expectRevert(bytes("signer holds no shares in WITHDRAW_HOOK"));
        script.withdrawAt(path, address(hook));
        vm.removeFile(path);
    }
}
