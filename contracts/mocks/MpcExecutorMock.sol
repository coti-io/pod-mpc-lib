// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import "../utils/mpc/MpcCore.sol";

import "../IInbox.sol";
import "../InboxUser.sol";

/// @title MpcExecutorMock
/// @notice Local stub executor: subset of `add`/`gt` paths for inbox integration tests (not full {IPodExecutor*}).
contract MpcExecutorMock is InboxUser {
    event AddResult(uint c, address cOwner);
    event Add128Result(uint result, address cOwner);
    event Add256Result(uint ciphertextHigh, uint ciphertextLow, address cOwner);
    event GtResult(uint result, address cOwner);

    /// @notice Create a mock MPC executor bound to an inbox.
    /// @param _inbox The inbox contract address.
    constructor(address _inbox) {
        setInbox(_inbox);
    }

    /// @notice Mock add implementation invoked remotely by the inbox.
    /// @param a Encrypted input a.
    /// @param b Encrypted input b.
    /// @param cOwner The owner of the result.
    function add64(gtUint64 a, gtUint64 b, address cOwner) external onlyInbox {
        uint c = uint256(gtUint64.unwrap(a)) + uint256(gtUint64.unwrap(b));
        bytes memory data = abi.encode(c);
        emit AddResult(c, cOwner);
        inbox.respond(data);
    }

    /// @notice Mock gt implementation invoked remotely by the inbox.
    /// @param a Encrypted input a.
    /// @param b Encrypted input b.
    /// @param cOwner The owner of the result.
    function gt64(gtUint64 a, gtUint64 b, address cOwner) external onlyInbox {
        uint result = uint256(gtUint64.unwrap(a)) > uint256(gtUint64.unwrap(b)) ? 1 : 0;
        bytes memory data = abi.encode(result);
        emit GtResult(result, cOwner);
        inbox.respond(data);
    }

    /// @notice Mock add128 implementation invoked remotely by the inbox.
    /// @param a Encrypted input a (gtUint128).
    /// @param b Encrypted input b (gtUint128).
    /// @param cOwner The owner of the result.
    function add128(gtUint128 a, gtUint128 b, address cOwner) external onlyInbox {
        ctUint128 result = ctUint128.wrap(gtUint128.unwrap(a) + gtUint128.unwrap(b));
        bytes memory data = abi.encode(result);
        emit Add128Result(ctUint128.unwrap(result), cOwner);
        inbox.respond(data);
    }

    /// @notice Mock add256 implementation invoked remotely by the inbox.
    /// @param a Encrypted input a (gtUint256).
    /// @param b Encrypted input b (gtUint256).
    /// @param cOwner The owner of the result.
    function add256(gtUint256 a, gtUint256 b, address cOwner) external onlyInbox {
        ctUint256 memory result = _add256Parts(a, b);
        bytes memory data = abi.encode(result);
        emit Add256Result(
            ctUint128.unwrap(result.ciphertextHigh),
            ctUint128.unwrap(result.ciphertextLow),
            cOwner
        );
        inbox.respond(data);
    }

    function _add256Parts(gtUint256 a, gtUint256 b) internal pure returns (ctUint256 memory) {
        uint256 sum = gtUint256.unwrap(a) + gtUint256.unwrap(b);
        return ctUint256({
            ciphertextHigh: ctUint128.wrap(sum >> 128),
            ciphertextLow: ctUint128.wrap(uint128(sum))
        });
    }
}
