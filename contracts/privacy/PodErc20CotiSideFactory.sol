// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

import "../token/perc20/cotiside/PodErc20CotiSideInitializable.sol";

/// @title PodErc20CotiSideFactory
/// @notice Deploys clone-based COTI-side pToken ledgers for the PoD privacy portal.
contract PodErc20CotiSideFactory is Ownable {
    address public immutable inbox;
    address public implementation;

    mapping(address => bool) public deployers;
    address[] public allCotiSideTokens;

    event DeployerUpdated(address indexed deployer, bool allowed);
    event ImplementationUpdated(address indexed implementation);
    event CotiSideTokenCreated(address indexed cotiSideToken, address indexed owner);

    error OnlyDeployer(address caller);
    error InvalidAddress();

    modifier onlyDeployer() {
        if (!deployers[msg.sender]) {
            revert OnlyDeployer(msg.sender);
        }
        _;
    }

    constructor(address initialOwner, address inbox_, address implementation_) Ownable(initialOwner) {
        if (initialOwner == address(0) || inbox_ == address(0) || implementation_ == address(0)) {
            revert InvalidAddress();
        }
        inbox = inbox_;
        implementation = implementation_;
        deployers[initialOwner] = true;
        emit DeployerUpdated(initialOwner, true);
        emit ImplementationUpdated(implementation_);
    }

    function setDeployer(address deployer, bool allowed) external onlyOwner {
        if (deployer == address(0)) {
            revert InvalidAddress();
        }
        deployers[deployer] = allowed;
        emit DeployerUpdated(deployer, allowed);
    }

    function setImplementation(address implementation_) external onlyOwner {
        if (implementation_ == address(0)) {
            revert InvalidAddress();
        }
        implementation = implementation_;
        emit ImplementationUpdated(implementation_);
    }

    function createCotiSideToken(address tokenOwner) external onlyDeployer returns (address cotiSideToken) {
        if (tokenOwner == address(0)) {
            revert InvalidAddress();
        }
        cotiSideToken = Clones.clone(implementation);
        PodErc20CotiSideInitializable(cotiSideToken).initialize(inbox, tokenOwner);
        allCotiSideTokens.push(cotiSideToken);
        emit CotiSideTokenCreated(cotiSideToken, tokenOwner);
    }

    function allCotiSideTokensLength() external view returns (uint256) {
        return allCotiSideTokens.length;
    }
}
