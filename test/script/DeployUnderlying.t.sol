// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {FixedPointMathLib as F} from "solady/utils/FixedPointMathLib.sol";
import {Deploy} from "../../script/Deploy.s.sol";
import {DeployUnderlying} from "../../script/DeployUnderlying.s.sol";
import {RenounceUnderlyingOracle} from "../../script/RenounceUnderlyingOracle.s.sol";
import {SeedUnderlying} from "../../script/SeedUnderlying.s.sol";
import {Underlyings} from "../../script/base/Underlyings.sol";
import {DemoToken} from "../../src/demo/DemoToken.sol";
import {PriceSteerer} from "../../src/demo/PriceSteerer.sol";
import {UnderlyingOracleHook} from "../../src/oracle/UnderlyingOracleHook.sol";

/// @dev Builds the ETH stack through Deploy's own `_deployUnderlying`, as on Unichain Sepolia
contract DeployEthStack is Deploy {
    function build(Deployment memory d) external returns (Deployment memory, string memory, string memory) {
        OracleConfig memory oc = oracleConfig();
        vm.startBroadcast(d.deployer);
        _deployUnderlying(d, oc, 500, 10);
        vm.stopBroadcast();
        return (d, _poolJson(d.underlyingPool), _oracleJson(oc));
    }
}

contract DeployUnderlyingHarness is DeployUnderlying {
    address internal immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function _startBroadcast() internal override returns (address) {
        vm.startBroadcast(signer);
        return signer;
    }

    function stage(string memory path, Params memory p) external returns (Underlying memory, bytes32) {
        return _stage(path, p);
    }

    function recordAt(string memory path) external {
        _record(path);
    }
}

contract SeedUnderlyingHarness is SeedUnderlying {
    address internal immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function _startBroadcast() internal override returns (address) {
        vm.startBroadcast(signer);
        return signer;
    }

    function seedAt(string memory path, string memory symbol, uint256 priceWad) external {
        _seed(path, symbol, priceWad);
    }
}

contract RenounceUnderlyingHarness is RenounceUnderlyingOracle {
    address internal immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function _startBroadcast() internal override returns (address) {
        vm.startBroadcast(signer);
        return signer;
    }

    function renounceAt(string memory path, address oracle, string memory symbol) external {
        _renounce(path, oracle, symbol);
    }
}

/// @notice DeployUnderlying and SeedUnderlying next to a Deploy-built ETH stack whose steerer the mirror owns
contract DeployUnderlyingTest is Test, Deployers {
    using StateLibrary for IPoolManager;

    uint256 internal constant T0 = 1_790_400_000;
    uint256 internal constant BLOCK = 4321;
    uint256 internal constant SOL_PRICE = 182.4e18;
    int256 internal constant LN_TICK_WAD = 99995000333308;
    uint160 internal constant ORACLE_FLAGS = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);

    address internal deployer = makeAddr("deployer");
    address internal mirror = makeAddr("mirror");
    Deploy.Deployment internal eth;
    string internal ethPoolJson;
    string internal oracleJson;
    DeployUnderlyingHarness internal script;
    SeedUnderlyingHarness internal seeder;
    string internal dir;

    function setUp() public {
        vm.warp(T0);
        vm.roll(BLOCK);
        deployFreshManagerAndRouters();
        Deploy.Deployment memory d;
        d.deployer = deployer;
        d.poolManager = address(manager);
        d.ethPriceWad = 2684.93e18;
        d.liquidity = 1e18;
        (d, ethPoolJson, oracleJson) = new DeployEthStack().build(d);
        eth = d;
        vm.prank(deployer);
        PriceSteerer(d.priceSteerer).transferOwnership(mirror);
        script = new DeployUnderlyingHarness(deployer);
        seeder = new SeedUnderlyingHarness(mirror);
        dir = string.concat(vm.projectRoot(), "/deployments/.run/test");
        vm.createDir(dir, true);
    }

    /* Helpers */

    function _seed(string memory name, string memory oracleParams) internal returns (string memory path) {
        path = string.concat(dir, "/deploy-underlying-", name, ".json");
        string memory head = string.concat(
            '{"chainId":',
            vm.toString(block.chainid),
            ',"network":"test","deployBlock":1,"deployer":"',
            vm.toString(deployer),
            '","poolManager":"',
            vm.toString(address(manager)),
            '","demoUsdc":"',
            vm.toString(eth.demoUsdc),
            '","demoWeth":"',
            vm.toString(eth.demoWeth),
            '","priceSteerer":"',
            vm.toString(eth.priceSteerer)
        );
        vm.writeFile(
            path,
            string.concat(
                head,
                '","underlyingOracle":"',
                vm.toString(eth.underlyingOracle),
                '","underlyingPoolId":"',
                vm.toString(PoolId.unwrap(eth.underlyingPool.toId())),
                '","underlyingPool":',
                ethPoolJson,
                ',"demoLiquidity":"1000000000000000000","oracleParams":',
                oracleParams,
                ',"legacyPredictionHooks":["0x0000000000000000000000000000000000000001"]}'
            )
        );
        _removeStaged(path);
    }

    function _seed(string memory name) internal returns (string memory) {
        return _seed(name, oracleJson);
    }

    function _pending(string memory path) internal pure returns (string memory) {
        return string.concat(vm.replace(path, ".json", ""), ".underlying.pending.json");
    }

    function _removeStaged(string memory path) internal {
        if (vm.exists(_pending(path))) vm.removeFile(_pending(path));
    }

    function _cleanup(string memory path) internal {
        if (vm.exists(path)) vm.removeFile(path);
        _removeStaged(path);
    }

    function _params(string memory symbol, uint256 priceWad) internal pure returns (DeployUnderlying.Params memory p) {
        p = DeployUnderlying.Params({
            symbol: symbol,
            name: string.concat("Demo Wrapped ", symbol),
            tokenSymbol: string.concat("d", symbol),
            priceWad: priceWad,
            faucetPerCall: 20e18,
            faucetPerHour: 100e18
        });
    }

    /// @dev Moves the deployer's nonce so the token's CREATE address sorts below or above demoUsdc
    function _orderToken(bool below) internal {
        uint64 n = vm.getNonce(deployer);
        while ((vm.computeCreateAddress(deployer, n) < eth.demoUsdc) != below) {
            ++n;
        }
        vm.setNonce(deployer, n);
    }

    function _add(string memory path, string memory symbol, uint256 priceWad)
        internal
        returns (Underlyings.Underlying memory u)
    {
        (u,) = script.stage(path, _params(symbol, priceWad));
        script.recordAt(path);
    }

    /* Deployment */

    function test_deploysTheStackWithTheTokenAsCurrency0() public {
        _checkStack("c0", true, SOL_PRICE);
    }

    function test_deploysTheStackWithTheTokenAsCurrency1() public {
        _checkStack("c1", false, SOL_PRICE);
    }

    function test_deploysAtALowAndAHighPrice() public {
        _checkStack("low", true, 0.0457e18);
        _checkStack("high", false, 65_432.1e18);
    }

    function _checkStack(string memory name, bool tokenIs0, uint256 priceWad) internal {
        string memory path = _seed(name);
        _orderToken(tokenIs0);
        uint64 nonce = vm.getNonce(deployer);

        (Underlyings.Underlying memory u, bytes32 salt) = script.stage(path, _params("SOL", priceWad));

        assertEq(vm.getNonce(deployer), nonce + 4, "four deployer transactions");
        assertEq(u.token < eth.demoUsdc, tokenIs0, "token ordering");
        DemoToken t = DemoToken(u.token);
        assertEq(t.name(), "Demo Wrapped SOL");
        assertEq(t.symbol(), "dSOL");
        assertEq(t.decimals(), 18);
        assertEq(t.owner(), deployer, "token owner");
        assertEq(t.faucetPerCall(), 20e18);
        assertEq(t.faucetPerHour(), 100e18);

        UnderlyingOracleHook o = UnderlyingOracleHook(u.oracle);
        UnderlyingOracleHook e = UnderlyingOracleHook(eth.underlyingOracle);
        assertEq(uint160(u.oracle) & Hooks.ALL_HOOK_MASK, ORACLE_FLAGS, "oracle flags");
        bytes memory init = abi.encodePacked(
            vm.getCode("src/oracle/UnderlyingOracleHook.sol:UnderlyingOracleHook"),
            abi.encode(
                address(manager),
                eth.demoUsdc,
                u.token,
                e.gridSeconds(),
                e.nWindows(),
                e.minWindows(),
                e.winsorTicks(),
                uint256(e.varMinE36()),
                uint256(e.varMaxE36()),
                e.fallbackVarE36(),
                e.cardinality(),
                deployer
            )
        );
        assertEq(
            vm.computeCreate2Address(salt, keccak256(init), CREATE2_FACTORY), u.oracle, "CREATE2 with the ETH params"
        );
        assertEq(o.owner(), deployer, "oracle owner");
        assertEq(o.usdc(), eth.demoUsdc, "oracle usdc side");
        assertEq(Currency.unwrap(o.underlying()), u.token, "oracle underlying");

        PoolId id = u.pool.toId();
        assertEq(PoolId.unwrap(o.poolId()), PoolId.unwrap(id), "oracle bound to the pool");
        assertEq(u.pool.fee, 500);
        assertEq(u.pool.tickSpacing, 10);
        assertEq(address(u.pool.hooks), u.oracle);
        (, int24 tick,,) = manager.getSlot0(id);
        int256 lnRaw = tokenIs0 ? F.lnWad(int256(priceWad / 1e12)) : F.lnWad(int256(1e48 / priceWad));
        assertApproxEqAbs(int256(tick), lnRaw / LN_TICK_WAD, 1, "pool tick at the requested price");

        assertTrue(t.isMinter(eth.priceSteerer), "steerer mints the token");
        assertEq(manager.getLiquidity(id), 0, "no liquidity before the seed step");
        assertApproxEqAbs(o.lnSpotSoBWad(), F.lnWad(int256(priceWad)), 1e12, "oracle spot");

        script.recordAt(path);
        uint64 mirrorNonce = vm.getNonce(mirror);
        seeder.seedAt(path, "SOL", 0);
        assertEq(vm.getNonce(mirror), mirrorNonce + 1, "one mirror transaction");
        assertEq(manager.getLiquidity(id), 1e18, "pool liquidity");
        (int24 lower, int24 upper) = (TickMath.minUsableTick(10), TickMath.maxUsableTick(10));
        (uint128 pos,,) = manager.getPositionInfo(id, eth.priceSteerer, lower, upper, bytes32(0));
        assertEq(pos, 1e18, "steerer full-range position");
        assertGt(t.balanceOf(address(manager)), 0, "token side funded");
        (, int24 tickAfter,,) = manager.getSlot0(id);
        assertEq(tickAfter, tick, "seeding leaves the price");
        assertApproxEqAbs(o.lnSpotSoBWad(), F.lnWad(int256(priceWad)), 1e12, "oracle spot after seeding");
        (uint256 v, bool warm) = o.varianceE36();
        assertFalse(warm);
        assertEq(v, e.fallbackVarE36());
        _cleanup(path);
    }

    function test_refusesOracleParamsThatDifferFromTheLiveEthOracle() public {
        string memory path = _seed("params", vm.replace(oracleJson, '"winsorTicks":100', '"winsorTicks":101'));
        vm.expectRevert(bytes("oracleParams differ from the live underlyingOracle"));
        script.stage(path, _params("SOL", SOL_PRICE));
        _cleanup(path);
    }

    function test_refusesABadSymbol() public {
        string memory path = _seed("symbol");
        vm.expectRevert(bytes("UNDERLYING_SYMBOL must be A-Z or 0-9"));
        script.stage(path, _params("sol", SOL_PRICE));
        vm.expectRevert(bytes("UNDERLYING_SYMBOL must be 1 to 6 characters"));
        script.stage(path, _params("SOLANAX", SOL_PRICE));
        _cleanup(path);
    }

    /* Deployments file */

    function test_recordSeedsEthThenAppendsTheNewEntry() public {
        string memory path = _seed("record");
        string memory before = vm.readFile(path);

        (Underlyings.Underlying memory u,) = script.stage(path, _params("SOL", SOL_PRICE));
        assertEq(vm.readFile(path), before, "stage leaves the deployments file");
        assertTrue(vm.exists(_pending(path)), "stage writes the pending file");
        script.recordAt(path);

        string memory json = vm.readFile(path);
        assertFalse(vm.exists(_pending(path)), "record removes the pending file");
        assertEq(vm.parseJsonString(json, ".underlyings[0].symbol"), "ETH");
        assertEq(vm.parseJsonAddress(json, ".underlyings[0].token"), eth.demoWeth);
        assertEq(vm.parseJsonAddress(json, ".underlyings[0].oracle"), eth.underlyingOracle);
        assertEq(vm.parseJsonBytes32(json, ".underlyings[0].poolId"), vm.parseJsonBytes32(json, ".underlyingPoolId"));
        assertEq(
            keccak256(vm.parseJson(json, ".underlyings[0].pool")),
            keccak256(vm.parseJson(json, ".underlyingPool")),
            "ETH pool"
        );
        assertEq(vm.parseJsonString(json, ".underlyings[1].symbol"), "SOL");
        assertEq(vm.parseJsonAddress(json, ".underlyings[1].token"), u.token);
        assertEq(vm.parseJsonAddress(json, ".underlyings[1].oracle"), u.oracle);
        assertEq(vm.parseJsonBytes32(json, ".underlyings[1].poolId"), PoolId.unwrap(u.pool.toId()));
        assertEq(vm.parseJsonAddress(json, ".underlyings[1].pool.currency0"), Currency.unwrap(u.pool.currency0));
        assertEq(vm.parseJsonAddress(json, ".underlyings[1].pool.currency1"), Currency.unwrap(u.pool.currency1));
        assertEq(vm.parseJsonUint(json, ".underlyings[1].pool.fee"), 500);
        assertEq(vm.parseJsonInt(json, ".underlyings[1].pool.tickSpacing"), 10);
        assertEq(vm.parseJsonAddress(json, ".underlyings[1].pool.hooks"), u.oracle);
        assertFalse(vm.keyExistsJson(json, ".underlyings[2]"));

        string[] memory keys = vm.parseJsonKeys(before, "$");
        assertEq(vm.parseJsonKeys(json, "$").length, keys.length + 1, "only underlyings is added");
        for (uint256 i; i < keys.length; ++i) {
            string memory k = string.concat(".", keys[i]);
            assertEq(keccak256(vm.parseJson(json, k)), keccak256(vm.parseJson(before, k)), keys[i]);
        }
        _cleanup(path);
    }

    function test_appendsToAnExistingList() public {
        string memory path = _seed("append");
        Underlyings.Underlying memory sol = _add(path, "SOL", SOL_PRICE);
        Underlyings.Underlying memory btc = _add(path, "BTC", 65_432.1e18);

        string memory json = vm.readFile(path);
        assertEq(vm.parseJsonString(json, ".underlyings[0].symbol"), "ETH");
        assertEq(vm.parseJsonAddress(json, ".underlyings[1].oracle"), sol.oracle);
        assertEq(vm.parseJsonString(json, ".underlyings[2].symbol"), "BTC");
        assertEq(vm.parseJsonAddress(json, ".underlyings[2].oracle"), btc.oracle);
        assertFalse(vm.keyExistsJson(json, ".underlyings[3]"));
        _cleanup(path);
    }

    function test_refusesADuplicateSymbol() public {
        string memory path = _seed("duplicate");
        vm.expectRevert(bytes("underlying ETH is already in the deployments file"));
        script.stage(path, _params("ETH", 2684.93e18));

        _add(path, "SOL", SOL_PRICE);
        vm.expectRevert(bytes("underlying SOL is already in the deployments file"));
        script.stage(path, _params("SOL", SOL_PRICE));
        _cleanup(path);
    }

    function test_recordRefusesASymbolRecordedSinceStaging() public {
        string memory path = _seed("race");
        script.stage(path, _params("SOL", SOL_PRICE));
        string memory staged = vm.readFile(_pending(path));
        vm.removeFile(_pending(path));
        _add(path, "SOL", 190e18);
        vm.writeFile(_pending(path), staged);

        vm.expectRevert(bytes("underlying SOL is already in the deployments file"));
        script.recordAt(path);
        _cleanup(path);
    }

    function test_stageRefusesWhileAnUnderlyingAwaitsRecord() public {
        string memory path = _seed("twice");
        script.stage(path, _params("SOL", SOL_PRICE));
        vm.expectRevert(bytes(string.concat("staged underlying awaits record(): ", _pending(path))));
        script.stage(path, _params("BTC", 65_432.1e18));
        _cleanup(path);
    }

    function test_recordRequiresAStagedUnderlying() public {
        string memory path = _seed("unstaged");
        vm.expectRevert(
            bytes(
                string.concat(
                    "no staged underlying at ", _pending(path), ", run DeployUnderlying with --broadcast first"
                )
            )
        );
        script.recordAt(path);
        _cleanup(path);
    }

    /* Seed */

    function test_seedSteersAnEmptyPoolToTheGivenPriceFirst() public {
        string memory path = _seed("seed-steer");
        Underlyings.Underlying memory u = _add(path, "SOL", SOL_PRICE);
        vm.prank(mirror);
        PriceSteerer(eth.priceSteerer).steer(u.pool, _sqrtAt(u, 20e18));
        vm.warp(T0 + 12);
        vm.roll(BLOCK + 1);
        assertApproxEqAbs(UnderlyingOracleHook(u.oracle).lnSpotSoBWad(), F.lnWad(20e18), 1e12, "empty pool pushed away");

        seeder.seedAt(path, "SOL", 190e18);

        vm.warp(T0 + 24);
        vm.roll(BLOCK + 2);
        assertApproxEqAbs(
            UnderlyingOracleHook(u.oracle).lnSpotSoBWad(), F.lnWad(190e18), 1e12, "seeded at the given price"
        );
        assertEq(manager.getLiquidity(u.pool.toId()), 1e18);
        _cleanup(path);
    }

    function test_seedRefusesASignerThatDoesNotOwnTheSteerer() public {
        string memory path = _seed("seed-signer");
        _add(path, "SOL", SOL_PRICE);
        SeedUnderlyingHarness other = new SeedUnderlyingHarness(deployer);
        vm.expectRevert(bytes("signer is not the priceSteerer owner"));
        other.seedAt(path, "SOL", 0);
        _cleanup(path);
    }

    function test_seedRefusesASeededPoolAndUnknownSymbols() public {
        string memory path = _seed("seed-twice");
        _add(path, "SOL", SOL_PRICE);
        seeder.seedAt(path, "SOL", 0);
        vm.expectRevert(bytes("pool of SOL already has liquidity"));
        seeder.seedAt(path, "SOL", 0);
        vm.expectRevert(bytes("pool of ETH already has liquidity"));
        seeder.seedAt(path, "ETH", 0);
        vm.expectRevert(bytes("underlying BTC is not in the deployments file"));
        seeder.seedAt(path, "BTC", 0);
        _cleanup(path);
    }

    function _sqrtAt(Underlyings.Underlying memory u, uint256 priceWad) internal pure returns (uint160) {
        if (Currency.unwrap(u.pool.currency0) == u.token) {
            return uint160(F.sqrt(F.fullMulDiv(priceWad, 1 << 192, 1e30)));
        }
        return uint160(F.sqrt(F.fullMulDiv(1e30, 1 << 192, priceWad)));
    }

    /* Renounce */

    function test_renouncesARecordedOracle() public {
        string memory path = _seed("renounce");
        Underlyings.Underlying memory u = _add(path, "SOL", SOL_PRICE);
        RenounceUnderlyingHarness r = new RenounceUnderlyingHarness(deployer);

        r.renounceAt(path, address(0), "SOL");

        assertEq(UnderlyingOracleHook(u.oracle).owner(), address(0));
        assertEq(UnderlyingOracleHook(eth.underlyingOracle).owner(), deployer, "ETH oracle untouched");
        _cleanup(path);
    }

    function test_renounceRefusesTheEthOracleAndUnlistedOracles() public {
        string memory path = _seed("renounce-refuse");
        Underlyings.Underlying memory u = _add(path, "SOL", SOL_PRICE);
        RenounceUnderlyingHarness r = new RenounceUnderlyingHarness(deployer);

        vm.expectRevert(bytes("that is the ETH oracle, use RenounceOracle"));
        r.renounceAt(path, eth.underlyingOracle, "");
        vm.expectRevert(bytes("no underlyings entry matches UNDERLYING_ORACLE / UNDERLYING_SYMBOL"));
        r.renounceAt(path, address(0xBEEF), "");
        vm.expectRevert(bytes("no underlyings entry matches UNDERLYING_ORACLE / UNDERLYING_SYMBOL"));
        r.renounceAt(path, u.oracle, "BTC");
        vm.expectRevert(bytes("set UNDERLYING_ORACLE or UNDERLYING_SYMBOL"));
        r.renounceAt(path, address(0), "");
        _cleanup(path);
    }

    function test_renounceRefusesASignerThatIsNotTheOwner() public {
        string memory path = _seed("renounce-signer");
        _add(path, "SOL", SOL_PRICE);
        RenounceUnderlyingHarness r = new RenounceUnderlyingHarness(makeAddr("other"));
        vm.expectRevert(bytes("signer is not the oracle owner"));
        r.renounceAt(path, address(0), "SOL");
        _cleanup(path);
    }
}
