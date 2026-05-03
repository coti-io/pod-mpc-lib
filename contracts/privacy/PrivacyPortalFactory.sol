// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

import "../token/perc20/PodErc20MintableInitializable.sol";
import "./IPrivacyPortal.sol";

/// @title PrivacyPortalFactory
/// @notice Deploys one-shot minimal-clone portals and pTokens for public ERC20 collateral.
contract PrivacyPortalFactory is Ownable {
    address public immutable inbox;
    uint256 public immutable cotiChainId;
    address public immutable podTokenImplementation;
    address public immutable portalImplementation;
    bool public withdrawalsPaused;

    mapping(address => bool) public deployers;
    mapping(address => address) public portalForUnderlying;
    mapping(address => address) public pTokenForUnderlying;
    mapping(address => address) public portalForPToken;

    event DeployerUpdated(address indexed deployer, bool allowed);
    event WithdrawalsPausedUpdated(bool paused);
    event PortalCreated(
        address indexed underlying,
        address indexed portal,
        address indexed pToken,
        address cotiSideToken,
        uint8 decimals
    );

    error OnlyDeployer(address caller);
    error InvalidAddress();
    error PortalAlreadyExists(address underlying, address portal);

    modifier onlyDeployer() {
        if (!deployers[msg.sender]) {
            revert OnlyDeployer(msg.sender);
        }
        _;
    }

    constructor(
        address initialOwner,
        address inbox_,
        uint256 cotiChainId_,
        address podTokenImplementation_,
        address portalImplementation_
    ) Ownable(initialOwner) {
        if (
            initialOwner == address(0) || inbox_ == address(0) || cotiChainId_ == 0
                || podTokenImplementation_ == address(0) || portalImplementation_ == address(0)
        ) {
            revert InvalidAddress();
        }
        inbox = inbox_;
        cotiChainId = cotiChainId_;
        podTokenImplementation = podTokenImplementation_;
        portalImplementation = portalImplementation_;
        deployers[initialOwner] = true;
        emit DeployerUpdated(initialOwner, true);
    }

    function setDeployer(address deployer, bool allowed) external onlyOwner {
        if (deployer == address(0)) {
            revert InvalidAddress();
        }
        deployers[deployer] = allowed;
        emit DeployerUpdated(deployer, allowed);
    }

    function setWithdrawalsPaused(bool paused) external onlyOwner {
        withdrawalsPaused = paused;
        emit WithdrawalsPausedUpdated(paused);
    }

    function createPortal(
        address underlying,
        address cotiSideToken,
        string calldata name,
        string calldata symbol,
        uint8 decimals,
        address portalOwner
    ) external onlyDeployer returns (address portal, address pToken) {
        if (underlying == address(0) || cotiSideToken == address(0) || portalOwner == address(0)) {
            revert InvalidAddress();
        }
        if (portalForUnderlying[underlying] != address(0)) {
            revert PortalAlreadyExists(underlying, portalForUnderlying[underlying]);
        }

        portal = Clones.clone(portalImplementation);
        pToken = Clones.clone(podTokenImplementation);

        PodErc20MintableInitializable(payable(pToken)).initialize(
            portal,
            cotiChainId,
            inbox,
            cotiSideToken,
            name,
            symbol,
            decimals
        );
        IPrivacyPortal(portal).initialize(portalOwner, underlying, pToken, decimals);

        portalForUnderlying[underlying] = portal;
        pTokenForUnderlying[underlying] = pToken;
        portalForPToken[pToken] = portal;

        emit PortalCreated(underlying, portal, pToken, cotiSideToken, decimals);
    }
}
