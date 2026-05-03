// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IPrivacyPortal {
    enum WithdrawalStatus {
        None,
        TransferPending,
        Released
    }

    struct Withdrawal {
        address user;
        address recipient;
        uint256 amount;
        uint256 burnFee;
        uint256 burnCallbackFee;
        bytes32 transferRequestId;
        bytes32 burnRequestId;
        WithdrawalStatus status;
    }

    function initialize(address owner, address underlyingToken, address pToken, uint8 decimals) external;

    function deposit(address recipient, uint256 amount, uint256 mintCallbackFee) external payable returns (bytes32 requestId);

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
    ) external payable returns (bytes32 withdrawalId, bytes32 transferRequestId);

    function onPTokenTransferred(bytes32 withdrawalId) external;
}
