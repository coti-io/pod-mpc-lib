import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { zeroHash } from "viem";
import {
  burnAccumulatedDebt,
  completePTokenTransferCallback,
  deployCotiSideFactory,
  deployDirectPortalContext,
  deployFactoryPortalPair,
  depositPublicToken,
  expectDepositMintSubmitted,
  expectWithdrawTransferSubmitted,
  fundUserAndApprovePortal,
  requestWithdraw,
  seedPortalVault,
  setBurnSubmissionFailure,
  zeroAddress,
  type PortalTestContext,
} from "./privacy-portal-utils.js";

describe("PrivacyPortal", { concurrency: 1 }, async function () {
  const { viem } = await network.connect({ network: "hardhat" });
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const owner = wallet.account.address as `0x${string}`;

  const freshPortal = () => deployDirectPortalContext({ viem, publicClient, wallet, owner });

  let ctx: PortalTestContext;

  before(async function () {
    ctx = await freshPortal();
  });

  it("deposit locks underlying and submits a public pToken mint", async function () {
    ctx = await freshPortal();

    await fundUserAndApprovePortal(ctx, 250n);
    await depositPublicToken(ctx, 250n);

    await expectDepositMintSubmitted(ctx, { amount: 250n });
  });

  it("withdraw submits a pToken transfer request without reading private balances", async function () {
    ctx = await freshPortal();
    await seedPortalVault(ctx, 500n);

    await requestWithdraw(ctx, 300n);

    await expectWithdrawTransferSubmitted(ctx, 300n);
  });

  it("withdraw callback releases underlying and submits burn", async function () {
    ctx = await freshPortal();
    await seedPortalVault(ctx, 500n);
    await requestWithdraw(ctx, 300n);

    const beforeRecipient = await ctx.underlying.read.balanceOf([ctx.recipient]);
    await completePTokenTransferCallback(ctx);

    assert.equal(await ctx.underlying.read.balanceOf([ctx.recipient]), beforeRecipient + 300n);
    assert.equal(await ctx.pToken.read.burnedAmount(), 300n);
    assert.equal(await ctx.portal.read.burnDebtAmount(), 0n);
  });

  it("records burn debt when burn submission fails and callback retry does not release twice", async function () {
    ctx = await freshPortal();
    await seedPortalVault(ctx, 500n);
    await setBurnSubmissionFailure(ctx, true);
    await requestWithdraw(ctx, 125n);

    const beforeRecipient = await ctx.underlying.read.balanceOf([ctx.recipient]);
    await completePTokenTransferCallback(ctx);
    await completePTokenTransferCallback(ctx);

    assert.equal(await ctx.underlying.read.balanceOf([ctx.recipient]), beforeRecipient + 125n);
    assert.equal(await ctx.portal.read.burnDebtAmount(), 125n);

    await setBurnSubmissionFailure(ctx, false);
    await burnAccumulatedDebt(ctx, 125n);
    assert.equal(await ctx.portal.read.burnDebtAmount(), 0n);
  });

  it("rejects portal callbacks that do not come from the configured pToken", async function () {
    ctx = await freshPortal();

    await assert.rejects(
      ctx.portal.write.onPTokenTransferred([zeroHash], { account: owner }),
      /OnlyPToken/
    );
  });

  it("factory deploys one portal and pToken clone per underlying token", async function () {
    ctx = await freshPortal();

    const { factory, underlying, portal, pToken } = await deployFactoryPortalPair(ctx);

    assert.notEqual(portal, zeroAddress);
    assert.notEqual(pToken, zeroAddress);
    assert.equal(await factory.read.portalForUnderlying([underlying.address]), portal);
    assert.equal(await factory.read.pTokenForUnderlying([underlying.address]), pToken);
    assert.equal(await factory.read.portalForPToken([pToken]), portal);

    const factoryPortal = await viem.getContractAt("PrivacyPortal", portal, {
      client: { public: publicClient, wallet },
    });
    const factoryPToken = await viem.getContractAt("PodErc20MintableInitializable", pToken, {
      client: { public: publicClient, wallet },
    });
    assert.equal(await factoryPortal.read.decimals(), 6);
    assert.equal(await factoryPToken.read.decimals(), 6);
  });

  it("factory pause disables withdrawals across factory-created portals", async function () {
    ctx = await freshPortal();
    const { factory, portal } = await deployFactoryPortalPair(ctx);
    const factoryPortal = await viem.getContractAt("PrivacyPortal", portal, {
      client: { public: publicClient, wallet },
    });

    await factory.write.setWithdrawalsPaused([true], { account: owner });

    await assert.rejects(
      factoryPortal.write.requestWithdrawWithPermit(
        [ctx.recipient, 1n, 100n, 11n, 200n, 22n, 999_999_999n, 27, zeroHash, zeroHash],
        { account: owner, value: 300n }
      ),
      /WithdrawalsPaused/
    );
  });

  it("COTI-side factory deploys initializer-only ledger clones", async function () {
    ctx = await freshPortal();
    const factory = await deployCotiSideFactory(ctx);

    await factory.write.createCotiSideToken([owner], { account: owner });

    assert.equal(await factory.read.allCotiSideTokensLength(), 1n);
    const token = await factory.read.allCotiSideTokens([0n]);
    assert.notEqual(token, zeroAddress);
  });
});
