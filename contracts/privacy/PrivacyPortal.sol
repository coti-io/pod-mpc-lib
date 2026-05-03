// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "../token/perc20/IPodERC20.sol";
import "./IPrivacyPortal.sol";

interface IPrivacyPortalPauseController {
    function withdrawalsPaused() external view returns (bool);
}

/// @title PrivacyPortal
/// @notice Locks a public ERC20 and mints/burns its PoD private pToken counterpart.
/// @dev The portal never reads private balances. It only reacts to successful pToken callbacks and records public bridge obligations.
contract PrivacyPortal is IPrivacyPortal, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public underlyingToken;
    IPodERC20 public pToken;
    address public pauseController;
    uint8 public decimals;

    uint256 public withdrawalNonce;
    uint256 public burnDebtAmount;

    mapping(bytes32 => Withdrawal) public withdrawals;

    event DepositRequested(
        address indexed user,
        address indexed recipient,
        uint256 amount,
        bytes32 indexed mintRequestId
    );
    event WithdrawalRequested(
        bytes32 indexed withdrawalId,
        address indexed user,
        address indexed recipient,
        uint256 amount,
        bytes32 transferRequestId
    );
    event WithdrawalReleased(bytes32 indexed withdrawalId, address indexed recipient, uint256 amount);
    event BurnSubmitted(bytes32 indexed withdrawalId, uint256 amount, bytes32 indexed burnRequestId);
    event BurnDebtRecorded(bytes32 indexed withdrawalId, uint256 amount, bytes reason);
    event BurnDebtSubmitted(address indexed caller, uint256 amount, bytes32 indexed burnRequestId);

    error InvalidAddress();
    error InvalidAmount();
    error IncorrectFee(uint256 expected, uint256 actual);
    error OnlyPToken(address caller);
    error UnknownWithdrawal(bytes32 withdrawalId);
    error WithdrawalNotPending(bytes32 withdrawalId, WithdrawalStatus status);
    error BurnDebtTooLow(uint256 debt, uint256 requested);
    error PortalAlreadyInitialized();
    error WithdrawalsPaused();

    constructor() Ownable(address(1)) {}

    receive() external payable {}

    function initialize(
        address owner_,
        address underlyingToken_,
        address pToken_,
        uint8 decimals_
    ) external override {
        if (address(underlyingToken) != address(0)) {
            revert PortalAlreadyInitialized();
        }
        if (owner_ == address(0)) {
            revert OwnableInvalidOwner(owner_);
        }
        if (underlyingToken_ == address(0) || pToken_ == address(0)) {
            revert InvalidAddress();
        }
        _transferOwnership(owner_);
        underlyingToken = IERC20(underlyingToken_);
        pToken = IPodERC20(pToken_);
        decimals = decimals_;
        pauseController = msg.sender;
    }

    /// @inheritdoc IPrivacyPortal
    function deposit(
        address recipient,
        uint256 amount,
        uint256 mintCallbackFee
    ) external payable override nonReentrant returns (bytes32 requestId) {
        if (recipient == address(0)) {
            revert InvalidAddress();
        }
        if (amount == 0) {
            revert InvalidAmount();
        }

        underlyingToken.safeTransferFrom(msg.sender, address(this), amount);
        requestId = pToken.mint{value: msg.value}(recipient, amount, mintCallbackFee);
        emit DepositRequested(msg.sender, recipient, amount, requestId);
    }

    /// @inheritdoc IPrivacyPortal
    function requestWithdrawWithPermit(
        address recipient,
        uint256 amount,
        uint256 transferFee,
        uint256 transferCallbackFee,
        uint256 burnFee,
        uint256 burnCallbackFee,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external payable override nonReentrant returns (bytes32 withdrawalId, bytes32 transferRequestId) {
        _checkWithdrawalsNotPaused();
        if (recipient == address(0)) {
            revert InvalidAddress();
        }
        if (amount == 0) {
            revert InvalidAmount();
        }
        uint256 expectedFee = transferFee + burnFee;
        if (msg.value != expectedFee) {
            revert IncorrectFee(expectedFee, msg.value);
        }

        withdrawalId = keccak256(abi.encodePacked(address(this), msg.sender, recipient, amount, withdrawalNonce++));
        bytes memory callbackData = abi.encodeWithSelector(this.onPTokenTransferred.selector, withdrawalId);

        IPodERC20.PublicPermit memory permit =
            IPodERC20.PublicPermit({deadline: permitDeadline, v: v, r: r, s: s});
        transferRequestId = pToken.transferFromAndCallWithPermit{value: transferFee}(
            msg.sender,
            address(this),
            amount,
            permit,
            callbackData,
            transferCallbackFee
        );

        withdrawals[withdrawalId] = Withdrawal({
            user: msg.sender,
            recipient: recipient,
            amount: amount,
            burnFee: burnFee,
            burnCallbackFee: burnCallbackFee,
            transferRequestId: transferRequestId,
            burnRequestId: bytes32(0),
            status: WithdrawalStatus.TransferPending
        });

        emit WithdrawalRequested(withdrawalId, msg.sender, recipient, amount, transferRequestId);
    }

    /// @inheritdoc IPrivacyPortal
    function onPTokenTransferred(bytes32 withdrawalId) external override nonReentrant {
        if (msg.sender != address(pToken)) {
            revert OnlyPToken(msg.sender);
        }

        Withdrawal storage withdrawal = withdrawals[withdrawalId];
        if (withdrawal.user == address(0)) {
            revert UnknownWithdrawal(withdrawalId);
        }
        if (withdrawal.status == WithdrawalStatus.Released) {
            return;
        }
        if (withdrawal.status != WithdrawalStatus.TransferPending) {
            revert WithdrawalNotPending(withdrawalId, withdrawal.status);
        }

        underlyingToken.safeTransfer(withdrawal.recipient, withdrawal.amount);
        withdrawal.status = WithdrawalStatus.Released;
        emit WithdrawalReleased(withdrawalId, withdrawal.recipient, withdrawal.amount);

        _trySubmitBurn(withdrawalId, withdrawal);
    }

    /// @notice Keeper/admin cleanup for pTokens already in portal custody when a previous burn submission failed.
    function burnAccumulatedDebt(
        uint256 amount,
        uint256 burnFee,
        uint256 burnCallbackFee
    ) external payable onlyOwner nonReentrant returns (bytes32 burnRequestId) {
        if (amount == 0) {
            revert InvalidAmount();
        }
        if (amount > burnDebtAmount) {
            revert BurnDebtTooLow(burnDebtAmount, amount);
        }
        if (msg.value != burnFee) {
            revert IncorrectFee(burnFee, msg.value);
        }

        burnRequestId = pToken.burn{value: burnFee}(amount, burnCallbackFee);
        burnDebtAmount -= amount;
        emit BurnDebtSubmitted(msg.sender, amount, burnRequestId);
    }

    function _trySubmitBurn(bytes32 withdrawalId, Withdrawal storage withdrawal) private {
        burnDebtAmount += withdrawal.amount;
        try pToken.burn{value: withdrawal.burnFee}(withdrawal.amount, withdrawal.burnCallbackFee) returns (
            bytes32 burnRequestId
        ) {
            burnDebtAmount -= withdrawal.amount;
            withdrawal.burnRequestId = burnRequestId;
            emit BurnSubmitted(withdrawalId, withdrawal.amount, burnRequestId);
        } catch (bytes memory reason) {
            emit BurnDebtRecorded(withdrawalId, withdrawal.amount, reason);
        }
    }

    function _checkWithdrawalsNotPaused() private view {
        if (pauseController == address(0)) {
            return;
        }
        (bool success, bytes memory data) = pauseController.staticcall(
            abi.encodeCall(IPrivacyPortalPauseController.withdrawalsPaused, ())
        );
        if (success && data.length >= 32 && abi.decode(data, (bool))) {
            revert WithdrawalsPaused();
        }
    }
}
