// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BinaryPricer} from "./BinaryPricer.sol";

/// @title PricingEngine
/// @notice Linked-library (DELEGATECALL) entry points to BinaryPricer. A caller that prices only through these keeps
///         NormalCdf, StudentTCdf and the spread band out of its own bytecode (PredictionHook vs EIP-170).
library PricingEngine {
    /// @notice BinaryPricer.priceKernel
    function price(int256 x, uint256 varE36, uint256 tau, uint256 window, uint256 n, uint8 kernel)
        external
        pure
        returns (BinaryPricer.Result memory)
    {
        return BinaryPricer.priceKernel(x, varE36, tau, window, n, kernel);
    }

    /// @notice BinaryPricer.priceKernel followed by BinaryPricer.askBid
    function quote(
        int256 x,
        uint256 varE36,
        uint256 tau,
        uint256 window,
        uint256 n,
        uint8 kernel,
        uint256 gammaSWad,
        uint256 h0Wad
    ) external pure returns (BinaryPricer.Result memory r, uint256 ask, uint256 bid) {
        r = BinaryPricer.priceKernel(x, varE36, tau, window, n, kernel);
        (ask, bid) = BinaryPricer.askBid(r, gammaSWad, h0Wad);
    }
}
