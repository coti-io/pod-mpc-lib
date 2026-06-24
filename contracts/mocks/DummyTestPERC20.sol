// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../token/erc7984/PodErc7984Mixin.sol";
import "../token/perc20/IPodERC20.sol";
import "../utils/mpc/MpcCore.sol";

/// @title DummyTestPERC20
/// @notice Synchronous test pToken with ERC-7984 `ConfidentialTransfer` on every completed move.
/// @dev No COTI or real inbox fees. Intended for explorer/event testing at fresh addresses without
///      upgrading production Sepolia deployments. The optional {PodCallbackTestInbox} can complete
///      pending moves to mimic async callback delivery.
contract DummyTestPERC20 is IPodERC20, PodErc7984Mixin {
    address public immutable minter;
    address public immutable callbackInbox;

    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;

    mapping(address => ctUint256) private _balances;
    mapping(address => uint256) private _plainBalances;
    mapping(bytes32 => RequestStatus) public requests;
    mapping(bytes32 => PendingMove) public pendingMoves;
    uint256 private _requestNonce;

    struct PendingMove {
        address from;
        address to;
        uint256 amount;
        bool pending;
    }

    error InvalidAddress();
    error OnlyMinter(address caller);
    error OnlyCallbackInbox(address caller);
    error UnknownRequest(bytes32 requestId);
    error MoveNotPending(bytes32 requestId);

    /// @param callbackInbox_ Inbox allowed to call {completeMoveFromInbox}; use zero to disable inbox completion.
    constructor(
        address minter_,
        address callbackInbox_,
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) {
        if (minter_ == address(0)) {
            revert InvalidAddress();
        }
        minter = minter_;
        callbackInbox = callbackInbox_;
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    /// @inheritdoc IPodERC20
    function balanceOf(address account) external view returns (ctUint256 memory) {
        return _balances[account];
    }

    /// @inheritdoc IPodERC20
    function balanceOfWithStatus(address account) external view returns (ctUint256 memory, bool pending) {
        return (_balances[account], false);
    }

    /// @notice Synchronous mint used by test portals; emits `Transfer` + `ConfidentialTransfer` in the same tx.
    function mint(address to, uint256 amount, uint256) external payable returns (bytes32 requestId) {
        _checkMinter();
        requestId = _nextRequestId();
        _applyMove(address(0), to, amount, requestId);
    }

    /// @notice Synchronous public transfer; emits `Transfer` + `ConfidentialTransfer` in the same tx.
    function transfer(address to, uint256 amount, uint256) external payable returns (bytes32 requestId) {
        requestId = _nextRequestId();
        _applyMove(msg.sender, to, amount, requestId);
    }

    /// @notice Async-shaped mint: returns `requestId` without moving balances until the callback inbox completes it.
    function mintPending(address to, uint256 amount) external returns (bytes32 requestId) {
        _checkMinter();
        requestId = _nextRequestId();
        pendingMoves[requestId] = PendingMove({from: address(0), to: to, amount: amount, pending: true});
        requests[requestId] = RequestStatus.Pending;
        emit RequestStatusUpdated(requestId, RequestStatus.Pending);
    }

    /// @notice Async-shaped transfer pending inbox completion.
    function transferPending(address to, uint256 amount) external returns (bytes32 requestId) {
        requestId = _nextRequestId();
        pendingMoves[requestId] = PendingMove({from: msg.sender, to: to, amount: amount, pending: true});
        requests[requestId] = RequestStatus.Pending;
        emit RequestStatusUpdated(requestId, RequestStatus.Pending);
    }

    /// @dev Callback inbox entry point mirroring a successful PoD callback.
    function completeMoveFromInbox(address from, address to, uint256 amount, bytes32 requestId) external {
        if (callbackInbox == address(0) || msg.sender != callbackInbox) {
            revert OnlyCallbackInbox(msg.sender);
        }
        PendingMove storage move = pendingMoves[requestId];
        if (!move.pending) {
            revert MoveNotPending(requestId);
        }
        if (move.from != from || move.to != to || move.amount != amount) {
            revert UnknownRequest(requestId);
        }
        delete pendingMoves[requestId];
        _applyMove(from, to, amount, requestId);
    }

    function _applyMove(address from, address to, uint256 amount, bytes32 requestId) private {
        if (from != address(0)) {
            _plainBalances[from] -= amount;
            _balances[from] = _balanceCt(from);
        }
        if (to != address(0)) {
            _plainBalances[to] += amount;
            _balances[to] = _balanceCt(to);
        }
        if (from == address(0)) {
            totalSupply += amount;
        }
        if (to == address(0)) {
            totalSupply -= amount;
        }

        ctUint256 memory senderValue = _amountCt(amount);
        ctUint256 memory receiverValue = _amountCt(amount);
        emit Transfer(from, to, senderValue, receiverValue);
        _emitConfidentialTransfer(from, to, senderValue, receiverValue);
        requests[requestId] = RequestStatus.Success;
        emit RequestStatusUpdated(requestId, RequestStatus.Success);
    }

    function _balanceCt(address account) private view returns (ctUint256 memory ct) {
        uint256 bal = _plainBalances[account];
        ct.ciphertextHigh = ctUint128.wrap(bal);
        ct.ciphertextLow = ctUint128.wrap(bal);
    }

    function _amountCt(uint256 amount) private pure returns (ctUint256 memory ct) {
        ct.ciphertextHigh = ctUint128.wrap(amount);
        ct.ciphertextLow = ctUint128.wrap(amount);
    }

    function _nextRequestId() private returns (bytes32 requestId) {
        requestId = keccak256(abi.encodePacked(address(this), block.chainid, _requestNonce++));
    }

    function _checkMinter() private view {
        if (msg.sender != minter) {
            revert OnlyMinter(msg.sender);
        }
    }

    function _erc7984BalanceOf(address account) internal view override returns (ctUint256 memory) {
        return _balances[account];
    }

    // --- IPodERC20 stubs (not used by deposit/transfer demo) ---

    function transfer(address, itUint256 calldata, uint256) external payable returns (bytes32) {
        revert("DummyTestPERC20: use transfer(to, amount, fee)");
    }

    function transfer(address, itUint256 calldata) external payable returns (bytes32) {
        revert("DummyTestPERC20: use transfer(to, amount, fee)");
    }

    function transferFrom(address, address, itUint256 calldata, uint256) external payable returns (bytes32) {
        revert("DummyTestPERC20: unsupported");
    }

    function transferFrom(address, address, itUint256 calldata) external payable returns (bytes32) {
        revert("DummyTestPERC20: unsupported");
    }

    function approve(address, itUint256 calldata, uint256) external payable returns (bytes32) {
        revert("DummyTestPERC20: unsupported");
    }

    function approve(address, itUint256 calldata) external payable returns (bytes32) {
        revert("DummyTestPERC20: unsupported");
    }

    function burn(itUint256 calldata, uint256) external payable returns (bytes32) {
        revert("DummyTestPERC20: unsupported");
    }

    function mint(address, itUint256 calldata, uint256) external payable returns (bytes32) {
        revert("DummyTestPERC20: use mint(to, amount, fee)");
    }

    function transferFrom(address, address, uint256, uint256) external payable returns (bytes32) {
        revert("DummyTestPERC20: unsupported");
    }

    function approve(address, uint256, uint256) external payable returns (bytes32) {
        revert("DummyTestPERC20: unsupported");
    }

    function burn(uint256, uint256) external payable returns (bytes32) {
        revert("DummyTestPERC20: unsupported");
    }

    function allowance(address, address) external pure returns (Allowance memory) {
        revert("DummyTestPERC20: unsupported");
    }

    function allowanceWithStatus(address, address) external pure returns (Allowance memory, bool) {
        revert("DummyTestPERC20: unsupported");
    }

    function syncBalances(address[] calldata, uint256) external payable returns (bytes32) {
        revert("DummyTestPERC20: unsupported");
    }

    function transferFromAndCall(
        address,
        address,
        uint256,
        bytes calldata,
        uint256
    ) external payable returns (bytes32) {
        revert("DummyTestPERC20: unsupported");
    }

    function transferFromAndCallWithPermit(
        address,
        address,
        uint256,
        PublicPermit calldata,
        bytes calldata,
        uint256
    ) external payable returns (bytes32) {
        revert("DummyTestPERC20: unsupported");
    }

    function transferAndCall(address, itUint256 calldata, bytes calldata, uint256) external payable returns (bytes32) {
        revert("DummyTestPERC20: unsupported");
    }

    function transferAndCall(address, uint256, bytes calldata, uint256) external payable returns (bytes32) {
        revert("DummyTestPERC20: unsupported");
    }
}
