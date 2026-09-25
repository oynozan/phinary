// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "solady/tokens/ERC20.sol";

/// @notice Stand-in for Circle's FiatToken USDC on Unichain Sepolia: 6 decimals, "USDC"/"USDC", minting only by the
///         master minter, blacklisting and pausing. Unlike Solady's default it grants Permit2 no implicit allowance.
contract CircleUSDC is ERC20 {
    error NotMasterMinter();
    error Blacklisted(address account);
    error Paused();

    address public immutable masterMinter;
    bool public paused;
    mapping(address => bool) public isBlacklisted;

    constructor(address masterMinter_) {
        masterMinter = masterMinter_;
    }

    modifier onlyMasterMinter() {
        if (msg.sender != masterMinter) revert NotMasterMinter();
        _;
    }

    function name() public pure override returns (string memory) {
        return "USDC";
    }

    function symbol() public pure override returns (string memory) {
        return "USDC";
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyMasterMinter {
        _mint(to, amount);
    }

    function blacklist(address account, bool on) external onlyMasterMinter {
        isBlacklisted[account] = on;
    }

    function setPaused(bool on) external onlyMasterMinter {
        paused = on;
    }

    function _givePermit2InfiniteAllowance() internal pure override returns (bool) {
        return false;
    }

    function _beforeTokenTransfer(address from, address to, uint256) internal view override {
        if (paused) revert Paused();
        if (isBlacklisted[from]) revert Blacklisted(from);
        if (isBlacklisted[to]) revert Blacklisted(to);
        if (isBlacklisted[msg.sender]) revert Blacklisted(msg.sender);
    }
}
