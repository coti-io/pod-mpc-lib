// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./PodErc20Mintable.sol";

/// @title PodErc20MintableInitializable
/// @notice Clone-friendly {PodErc20Mintable}; the implementation constructor only locks the implementation instance.
contract PodErc20MintableInitializable is PodErc20Mintable {
    constructor() PodErc20Mintable(address(1), 1, address(1), address(1), "IMPLEMENTATION", "IMPL") {}

    function initialize(
        address _minter,
        uint256 _cotiChainId,
        address _inbox,
        address _cotiSideContract,
        string memory _name,
        string memory _symbol,
        uint8 _decimals
    ) external {
        _initializePodErc20Mintable(_minter, _cotiChainId, _inbox, _cotiSideContract, _name, _symbol, _decimals);
    }
}
