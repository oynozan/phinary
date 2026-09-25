// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "solady/tokens/ERC20.sol";
import {Ownable} from "solady/auth/Ownable.sol";

/// @title DemoToken
/// @notice Testnet ERC20 for the underlying ETH/USDC oracle pool ("demo WETH", "demo USDC").
/// @dev The owner and approved minters mint without limit. Anyone may use `faucet`, capped per call and per
///      address per hour, where each address's hour starts at its first faucet mint after the previous one ended.
contract DemoToken is ERC20, Ownable {
    error NotMinter();
    error FaucetPerCallExceeded(uint256 amount, uint256 perCall);
    error FaucetHourlyExceeded(uint256 amount, uint256 remaining);

    event MinterSet(address indexed account, bool allowed);
    event FaucetLimitsSet(uint256 perCall, uint256 perHour);
    event FaucetMint(address indexed account, uint256 amount);

    struct FaucetWindow {
        uint256 start;
        uint256 minted;
    }

    uint256 public constant FAUCET_WINDOW = 1 hours;

    uint8 private immutable _decimals;
    string private _name;
    string private _symbol;

    uint256 public faucetPerCall;
    uint256 public faucetPerHour;
    mapping(address => bool) public isMinter;
    mapping(address => FaucetWindow) public faucetWindow;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 faucetPerCall_,
        uint256 faucetPerHour_,
        address owner_
    ) {
        _name = name_;
        _symbol = symbol_;
        _decimals = decimals_;
        faucetPerCall = faucetPerCall_;
        faucetPerHour = faucetPerHour_;
        _initializeOwner(owner_);
        emit FaucetLimitsSet(faucetPerCall_, faucetPerHour_);
    }

    function name() public view override returns (string memory) {
        return _name;
    }

    function symbol() public view override returns (string memory) {
        return _symbol;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Unlimited mint for the owner and approved minters.
    function mint(address to, uint256 amount) external {
        if (msg.sender != owner() && !isMinter[msg.sender]) revert NotMinter();
        _mint(to, amount);
    }

    /// @notice Public faucet: mints `amount` to the caller within the per-call and per-hour caps.
    function faucet(uint256 amount) external {
        if (amount > faucetPerCall) revert FaucetPerCallExceeded(amount, faucetPerCall);
        FaucetWindow memory w = faucetWindow[msg.sender];
        if (w.minted == 0 || block.timestamp >= w.start + FAUCET_WINDOW) w = FaucetWindow(block.timestamp, 0);
        uint256 remaining = faucetPerHour > w.minted ? faucetPerHour - w.minted : 0;
        if (amount > remaining) revert FaucetHourlyExceeded(amount, remaining);
        w.minted += amount;
        faucetWindow[msg.sender] = w;
        _mint(msg.sender, amount);
        emit FaucetMint(msg.sender, amount);
    }

    /// @notice Amount `account` can still take from the faucet in its current window.
    function faucetRemaining(address account) external view returns (uint256) {
        FaucetWindow memory w = faucetWindow[account];
        if (block.timestamp >= w.start + FAUCET_WINDOW) return faucetPerHour;
        return faucetPerHour > w.minted ? faucetPerHour - w.minted : 0;
    }

    function setMinter(address account, bool allowed) external onlyOwner {
        isMinter[account] = allowed;
        emit MinterSet(account, allowed);
    }

    function setFaucetLimits(uint256 perCall, uint256 perHour) external onlyOwner {
        faucetPerCall = perCall;
        faucetPerHour = perHour;
        emit FaucetLimitsSet(perCall, perHour);
    }
}
