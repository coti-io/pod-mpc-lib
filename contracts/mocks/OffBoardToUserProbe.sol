// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../utils/mpc/MpcCore.sol";

/// @notice COTI-side probe for comparing `offBoard` vs `offBoardToUser` across addresses.
/// MPC precompile calls must run in a transaction; results are stored for view reads.
contract OffBoardToUserProbe {
    ctUint256 public lastOffBoardToUser;
    ctUint256 public lastOffBoard;
    ctUint256 public lastPlainZero;

    function probeOffBoardToUser(uint256 value, address user) external returns (ctUint256 memory ct) {
        ct = MpcCore.offBoardToUser(MpcCore.setPublic256(value), user);
        lastOffBoardToUser = ct;
    }

    function probeOffBoard(uint256 value) external returns (ctUint256 memory ct) {
        ct = MpcCore.offBoard(MpcCore.setPublic256(value));
        lastOffBoard = ct;
    }

    function probePlainZero() external returns (ctUint256 memory ct) {
        ct = MpcCore.offBoard(MpcCore.setPublic256(0));
        lastPlainZero = ct;
    }
}
