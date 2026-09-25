// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "solady/tokens/ERC20.sol";

/// @title OutcomeToken
/// @notice YES/NO token of one prediction market. 6 decimals (same unit as USDC). Only the hook mints and burns.
/// @dev Solady ERC20 gives Permit2 an infinite allowance by default, so UniversalRouter swaps need only a Permit2
///      signature, not an ERC20 approve transaction.
contract OutcomeToken is ERC20 {
    error OnlyHook();

    address public immutable hook;
    uint256 public immutable marketId;
    bool public immutable isYes;
    string private _name;
    string private _symbol;

    constructor(string memory name_, string memory symbol_, uint256 marketId_, bool isYes_) {
        hook = msg.sender;
        marketId = marketId_;
        isYes = isYes_;
        _name = name_;
        _symbol = symbol_;
    }

    modifier onlyHook() {
        if (msg.sender != hook) revert OnlyHook();
        _;
    }

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyHook {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyHook {
        _burn(from, amount);
    }
}
