// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "solmate/src/tokens/ERC20.sol";

/// @notice YES/NO outcome token. 6 decimals (same base unit as USDC), mint/burn restricted to the hook,
///         no transfer hooks/callbacks (so the hook's sync -> mint(PM) -> settle is atomic and exact).
contract OutcomeToken is ERC20 {
    address public immutable hook;

    error OnlyHook();

    constructor(string memory n, string memory s) ERC20(n, s, 6) {
        hook = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != hook) revert OnlyHook();
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (msg.sender != hook) revert OnlyHook();
        _burn(from, amount);
    }
}

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC", 6) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
