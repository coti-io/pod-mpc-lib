// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "../token/perc20/IPodERC20.sol";

contract MockPodERC20ForPortal {
    bytes32 public nextRequestId = bytes32(uint256(1));
    address public lastMintRecipient;
    uint256 public lastMintAmount;
    uint256 public lastMintValue;
    uint256 public lastMintCallbackFee;
    address public lastTransferFrom;
    address public lastTransferTo;
    uint256 public lastTransferAmount;
    uint256 public lastTransferValue;
    uint256 public lastTransferCallbackFee;
    bytes public lastTransferCallbackData;
    uint256 public burnedAmount;
    bool public burnShouldRevert;

    function mint(address to, uint256 amount, uint256 callbackFeeLocalWei) external payable returns (bytes32 requestId) {
        lastMintRecipient = to;
        lastMintAmount = amount;
        lastMintValue = msg.value;
        lastMintCallbackFee = callbackFeeLocalWei;
        return _consumeRequestId();
    }

    function transferFromAndCallWithPermit(
        address from,
        address to,
        uint256 amount,
        IPodERC20.PublicPermit calldata,
        bytes calldata data,
        uint256 callbackFeeLocalWei
    ) external payable returns (bytes32 requestId) {
        lastTransferFrom = from;
        lastTransferTo = to;
        lastTransferAmount = amount;
        lastTransferValue = msg.value;
        lastTransferCallbackFee = callbackFeeLocalWei;
        lastTransferCallbackData = data;
        return _consumeRequestId();
    }

    function burn(uint256 amount, uint256) external payable returns (bytes32 requestId) {
        if (burnShouldRevert) {
            revert("MockPodERC20ForPortal: burn failed");
        }
        burnedAmount += amount;
        return _consumeRequestId();
    }

    function setBurnShouldRevert(bool value) external {
        burnShouldRevert = value;
    }

    function triggerLastTransferCallback() external returns (bytes memory returndata) {
        (bool success, bytes memory data) = lastTransferTo.call(lastTransferCallbackData);
        require(success, string(data));
        return data;
    }

    function _consumeRequestId() private returns (bytes32 requestId) {
        requestId = nextRequestId;
        nextRequestId = bytes32(uint256(nextRequestId) + 1);
    }
}
