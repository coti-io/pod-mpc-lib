// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../token/erc7984/PodErc7984Mixin.sol";
import "../utils/mpc/MpcCore.sol";

/// @dev Minimal harness for ERC-7984 unit tests without inbox/COTI wiring.
contract PodErc7984TestHarness is PodErc7984Mixin {
    string public name;
    string public symbol;
    uint8 public decimals;

    mapping(address => ctUint256) private _balances;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function setBalance(address account, ctUint256 memory ct) external {
        _balances[account] = ct;
    }

    function emitCompletedTransfer(
        address from,
        address to,
        ctUint256 memory senderValue,
        ctUint256 memory receiverValue
    ) external {
        _emitConfidentialTransfer(from, to, senderValue, receiverValue);
    }

    function _erc7984BalanceOf(address account) internal view override returns (ctUint256 memory) {
        return _balances[account];
    }
}
