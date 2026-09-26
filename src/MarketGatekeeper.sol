// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IMarketGatekeeper} from "./interfaces/IMarketGatekeeper.sol";
import {IPredictionHook} from "./interfaces/IPredictionHook.sol";
import {MarketScheduler} from "./MarketScheduler.sol";

/// @title MarketGatekeeper
/// @notice Ownerless contract that becomes a PredictionHook's `owner` and deploys one MarketScheduler per track in its
///         constructor, so the track set is fixed forever. `createMarket` is forwarded to the hook only when called by
///         one of those schedulers; there is no setter and no admin.
/// @dev The hook's `keeper` is never set (stays address(0)), since the gatekeeper has no path to `setKeeper`. The
///      constructor never calls `hook_`, so the hook may be deployed after the gatekeeper with it as `owner`.
contract MarketGatekeeper is IMarketGatekeeper {
    uint256 internal constant MAX_TRACKS = 8;

    IPredictionHook public immutable hook;
    uint256 public immutable schedulerCount;

    /// @dev Immutables cannot be arrays; slots at or past `schedulerCount` stay address(0)
    address internal immutable _s0;
    address internal immutable _s1;
    address internal immutable _s2;
    address internal immutable _s3;
    address internal immutable _s4;
    address internal immutable _s5;
    address internal immutable _s6;
    address internal immutable _s7;

    mapping(uint256 marketId => address scheduler) public schedulerOf;

    /// @param tracks One per scheduler, 1 to 8 of them with distinct tickers and nonzero oracles; each scheduler reads
    ///        its own track's oracle, and a config the scheduler rejects reverts with its InvalidConfig
    constructor(IPredictionHook hook_, Track[] memory tracks) {
        uint256 n = tracks.length;
        if (address(hook_) == address(0) || n == 0 || n > MAX_TRACKS) revert InvalidTracks();
        for (uint256 i; i < n; ++i) {
            if (tracks[i].oracle == address(0)) revert InvalidTracks();
            bytes32 ticker = keccak256(bytes(tracks[i].config.ticker));
            for (uint256 j; j < i; ++j) {
                if (keccak256(bytes(tracks[j].config.ticker)) == ticker) revert InvalidTracks();
            }
        }

        hook = hook_;
        schedulerCount = n;
        address[MAX_TRACKS] memory s;
        for (uint256 i; i < n; ++i) {
            s[i] = address(new MarketScheduler(hook_, this, tracks[i].oracle, tracks[i].config));
        }
        _s0 = s[0];
        _s1 = s[1];
        _s2 = s[2];
        _s3 = s[3];
        _s4 = s[4];
        _s5 = s[5];
        _s6 = s[6];
        _s7 = s[7];
    }

    /// @inheritdoc IMarketGatekeeper
    function createMarket(IPredictionHook.MarketParams calldata p) external returns (uint256 marketId) {
        if (!isScheduler(msg.sender)) revert NotScheduler();
        marketId = hook.createMarket(p);
        schedulerOf[marketId] = msg.sender;
    }

    /// @inheritdoc IMarketGatekeeper
    function schedulers() external view returns (address[] memory s) {
        s = new address[](schedulerCount);
        address[MAX_TRACKS] memory all = [_s0, _s1, _s2, _s3, _s4, _s5, _s6, _s7];
        for (uint256 i; i < s.length; ++i) {
            s[i] = all[i];
        }
    }

    /// @inheritdoc IMarketGatekeeper
    function isScheduler(address account) public view returns (bool) {
        return account != address(0)
            && (account == _s0
                || account == _s1
                || account == _s2
                || account == _s3
                || account == _s4
                || account == _s5
                || account == _s6
                || account == _s7);
    }
}
