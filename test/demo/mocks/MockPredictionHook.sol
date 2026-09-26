// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {IPredictionHook} from "../../../src/interfaces/IPredictionHook.sol";
import {IUnderlyingOracle} from "../../../src/interfaces/IUnderlyingOracle.sol";

/// @notice Ledger-only IPredictionHook used to exercise the keeper bot end to end. No pools, no tokens.
/// @dev Settlement compares the oracle's current log price with the strike; `blockSettle` simulates an oracle outage.
contract MockPredictionHook is IPredictionHook {
    error NotKeeper();
    error NotTrading();
    error NotExpired();
    error NotSettled();
    error OracleDown();
    error InsufficientIdle();

    uint256 public constant GRACE = 30;

    address public immutable owner;
    address public keeper;
    address public immutable usdc;
    uint256 public vaultIdle;
    bool public blockSettle;

    MarketParams[] internal _params;
    MarketInfo[] internal _info;

    constructor(address owner_, address usdc_, uint256 idle_) {
        owner = owner_;
        usdc = usdc_;
        vaultIdle = idle_;
    }

    function setKeeper(address k) external {
        if (msg.sender != owner) revert NotKeeper();
        keeper = k;
        emit KeeperSet(k);
    }

    function setBlockSettle(bool b) external {
        blockSettle = b;
    }

    function setOutstanding(uint256 id, uint256 outYes, uint256 outNo, uint256 premiums) external {
        MarketInfo storage m = _info[id];
        m.outYes = outYes;
        m.outNo = outNo;
        m.bucket += premiums;
    }

    function createMarket(MarketParams calldata p) external returns (uint256 marketId) {
        if (msg.sender != owner && msg.sender != keeper) revert NotKeeper();
        if (vaultIdle < p.budget) revert InsufficientIdle();
        require(p.expiry > p.openTime + p.window + p.cutoffBuffer, "timing");
        vaultIdle -= p.budget;
        marketId = _info.length;
        _params.push(p);
        MarketInfo memory m;
        m.oracle = p.oracle;
        m.lnStrikeWad = p.lnStrikeWad;
        m.openTime = p.openTime;
        m.expiry = p.expiry;
        m.window = p.window;
        m.cutoffBuffer = p.cutoffBuffer;
        m.status = Status.Trading;
        m.bucket = p.budget;
        _info.push(m);
        emit MarketCreated(marketId, address(0), address(0), bytes32(0), bytes32(0), p.lnStrikeWad, p.expiry);
    }

    function settle(uint256 id) external {
        MarketInfo storage m = _info[id];
        if (m.status != Status.Trading) revert NotTrading();
        if (block.timestamp < m.expiry) revert NotExpired();
        if (blockSettle) revert OracleDown();
        m.yesWon = IUnderlyingOracle(m.oracle).lnSpotSoBWad() > m.lnStrikeWad;
        m.status = Status.Settled;
        emit MarketSettled(id, m.yesWon, 0, false);
    }

    function settleInvalid(uint256 id) external {
        MarketInfo storage m = _info[id];
        if (m.status != Status.Trading) revert NotTrading();
        if (block.timestamp <= m.expiry + GRACE) revert NotExpired();
        m.status = Status.Invalid;
        emit MarketSettled(id, false, 0, true);
    }

    function sweep(uint256 id) external returns (uint256 amount) {
        MarketInfo storage m = _info[id];
        uint256 owed;
        if (m.status == Status.Settled) owed = m.yesWon ? m.outYes : m.outNo;
        else if (m.status == Status.Invalid) owed = (m.outYes + m.outNo + 1) / 2;
        else revert NotSettled();
        amount = m.bucket > owed ? m.bucket - owed : 0;
        m.bucket -= amount;
        vaultIdle += amount;
        emit Swept(id, amount);
    }

    function redeem(uint256, uint256) external pure returns (uint256) {
        return 0;
    }

    function deposit(uint256) external pure returns (uint256) {
        return 0;
    }

    function withdraw(uint256) external pure returns (uint256) {
        return 0;
    }

    function quote(uint256) external pure returns (Quote memory q) {
        return q;
    }

    function marketInfo(uint256 id) external view returns (MarketInfo memory) {
        return _info[id];
    }

    function marketParams(uint256 id) external view returns (MarketParams memory) {
        return _params[id];
    }

    function poolKeys(uint256) external pure returns (PoolKey memory yesKey, PoolKey memory noKey) {
        return (yesKey, noKey);
    }

    function marketCount() external view returns (uint256) {
        return _info.length;
    }

    function marketOfPool(bytes32) external pure returns (uint256, bool) {
        return (0, false);
    }

    function navPlus() external view returns (uint256) {
        return vaultIdle;
    }

    function navMinus() external view returns (uint256) {
        return vaultIdle;
    }

    function totalShares() external pure returns (uint256) {
        return 0;
    }

    function sharesOf(address) external pure returns (uint256) {
        return 0;
    }
}
