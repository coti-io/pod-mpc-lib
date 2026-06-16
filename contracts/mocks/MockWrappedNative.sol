// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../utils/IWrappedNative.sol";

/// @dev WETH9-style wrapped native token for Hardhat tests.
contract MockWrappedNative is ERC20, IWrappedNative {
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /// @dev Test helper to seed portal vault without wrapping native coin.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    receive() external payable {
        deposit();
    }

    function deposit() public payable override {
        _mint(msg.sender, msg.value);
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 wad) public override {
        _burn(msg.sender, wad);
        (bool ok,) = payable(msg.sender).call{value: wad}("");
        require(ok, "MockWrappedNative: withdraw failed");
        emit Withdrawal(msg.sender, wad);
    }
}
