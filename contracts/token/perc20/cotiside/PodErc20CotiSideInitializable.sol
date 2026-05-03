// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./PodErc20CotiSide.sol";

/// @title PodErc20CotiSideInitializable
/// @notice Minimal-clone friendly COTI-side pToken ledger.
contract PodErc20CotiSideInitializable is PodErc20CotiSide {
    constructor() PodErc20CotiSide(address(1), address(1)) {}

    function initialize(address inboxAddress, address initialOwner) external {
        _initializePodErc20CotiSide(inboxAddress, initialOwner);
    }
}
