// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";

/// @title IPredictionHook
/// @notice External API of the Black-Scholes-priced binary prediction-market hook (see docs/SPEC.md).
interface IPredictionHook {
    enum Status {
        None,
        Trading,
        Settled,
        Invalid
    }

    struct QuoteParams {
        uint64 h0Wad; // base half-spread
        uint64 gammaSWad; // log-price uncertainty of S used in the gamma spread term
        uint128 lambdaWad; // marginal-price impact per whole token of net epoch flow (WAD)
        uint128 qEpochMax; // max |net flow| per epoch, 1e-6 token units
        uint64 pMinWad; // tradable band [pMin, 1 - pMin]
    }

    struct MarketParams {
        address oracle;
        int256 lnStrikeWad; // ln(USD strike), WAD
        uint64 openTime;
        uint64 expiry;
        uint32 window; // settlement averaging window, seconds
        uint32 cutoffBuffer; // trading stops at expiry - window - cutoffBuffer
        uint32 nSamples; // samples in the window for the discrete Asian formula (0 = continuous)
        uint256 budget; // USDC (6 dec) allocated from the LP vault
        QuoteParams quote;
        uint8 sigmaMode; // 0 = oracle variance, 1 = fixed
        uint256 fixedVarE36; // per-second variance at 1e36 (sigmaMode == 1, or unused)
        uint8 kernel; // 0 = Gaussian (Black-Scholes), 1 = Student-t nu=5 (optional)
        string yesName;
        string yesSymbol;
        string noName;
        string noSymbol;
    }

    struct MarketInfo {
        address yes;
        address no;
        address oracle;
        int256 lnStrikeWad;
        uint64 openTime;
        uint64 expiry;
        uint32 window;
        uint32 cutoffBuffer;
        Status status;
        bool yesWon;
        uint256 bucket;
        uint256 outYes;
        uint256 outNo;
        uint256 invYes;
        uint256 invNo;
    }

    struct Quote {
        bool tradable; // within [openTime, cutoff)
        uint256 tau; // seconds to expiry
        uint256 varE36; // per-second variance used
        int256 xWad; // ln(S_sob / K)
        uint256 midYes; // WAD
        uint256 askYes;
        uint256 bidYes;
        uint256 askNo;
        uint256 bidNo;
    }

    event MarketCreated(
        uint256 indexed marketId, address yes, address no, bytes32 yesPoolId, bytes32 noPoolId, int256 lnStrikeWad, uint64 expiry
    );
    event Trade(
        uint256 indexed marketId,
        address indexed sender,
        bool isYes,
        bool isBuy,
        uint256 qty,
        uint256 usdcAmount,
        uint256 avgPriceWad
    );
    event MarketSettled(uint256 indexed marketId, bool yesWon, int256 avgNormTickTimesWindow, bool invalid);
    event Redeemed(uint256 indexed marketId, address indexed account, uint256 amount, uint256 payout);
    event Swept(uint256 indexed marketId, uint256 amount);
    event Deposit(address indexed account, uint256 assets, uint256 shares);
    event Withdraw(address indexed account, uint256 assets, uint256 shares);
    event KeeperSet(address keeper);

    function createMarket(MarketParams calldata p) external returns (uint256 marketId);
    function settle(uint256 marketId) external;
    function settleInvalid(uint256 marketId) external;
    function redeem(uint256 marketId, uint256 amount) external returns (uint256 payout);
    function sweep(uint256 marketId) external returns (uint256 amount);

    function deposit(uint256 assets) external returns (uint256 shares);
    function withdraw(uint256 shares) external returns (uint256 assets);

    function quote(uint256 marketId) external view returns (Quote memory);
    function marketInfo(uint256 marketId) external view returns (MarketInfo memory);
    function marketParams(uint256 marketId) external view returns (MarketParams memory);
    function poolKeys(uint256 marketId) external view returns (PoolKey memory yesKey, PoolKey memory noKey);
    function marketCount() external view returns (uint256);
    function marketOfPool(bytes32 poolId) external view returns (uint256 marketId, bool isYes);

    function usdc() external view returns (address);
    function vaultIdle() external view returns (uint256);
    function navPlus() external view returns (uint256);
    function navMinus() external view returns (uint256);
    function totalShares() external view returns (uint256);
    function sharesOf(address account) external view returns (uint256);
}
