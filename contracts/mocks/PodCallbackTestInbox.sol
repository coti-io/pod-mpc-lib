// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./DummyTestPERC20.sol";

/// @title PodCallbackTestInbox
/// @notice Minimal inbox stub that completes pending DummyTestPERC20 moves without COTI or fees.
/// @dev Used in ERC-7984 tests to exercise callback-shaped completion paths with fewer moving parts.
contract PodCallbackTestInbox {
    /// @notice Complete a pending mint on `token` (from zero address).
    function completeMint(DummyTestPERC20 token, bytes32 requestId, address to, uint256 amount) external {
        token.completeMoveFromInbox(address(0), to, amount, requestId);
    }

    /// @notice Complete a pending transfer on `token`.
    function completeTransfer(
        DummyTestPERC20 token,
        bytes32 requestId,
        address from,
        address to,
        uint256 amount
    ) external {
        token.completeMoveFromInbox(from, to, amount, requestId);
    }
}
