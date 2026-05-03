import assert from "node:assert/strict";
import { getAddress, zeroAddress, zeroHash, type PublicClient, type WalletClient } from "viem";

export const RECIPIENT = "0x00000000000000000000000000000000000000b0" as `0x${string}`;
export const COTI_SIDE_TOKEN = "0x00000000000000000000000000000000000000c0" as `0x${string}`;

export const DEFAULT_WITHDRAW = {
  transferFee: 100n,
  transferCallbackFee: 11n,
  burnFee: 200n,
  burnCallbackFee: 22n,
  permitDeadline: 999_999_999n,
  v: 27,
  r: zeroHash,
  s: zeroHash,
} as const;

export type PortalTestContext = {
  viem: any;
  publicClient: PublicClient;
  wallet: WalletClient;
  owner: `0x${string}`;
  recipient: `0x${string}`;
  underlying: any;
  pToken: any;
  portal: any;
};

const writeOpts = (ctx: PortalTestContext) => ({ account: ctx.owner });

export async function deployDirectPortalContext(params: {
  viem: any;
  publicClient: PublicClient;
  wallet: WalletClient;
  owner: `0x${string}`;
}): Promise<PortalTestContext> {
  const underlying = await params.viem.deployContract("MockERC20", ["USD Coin", "USDC"], {
    client: { public: params.publicClient, wallet: params.wallet },
  });
  const pToken = await params.viem.deployContract("MockPodERC20ForPortal", [], {
    client: { public: params.publicClient, wallet: params.wallet },
  });
  const portal = await params.viem.deployContract("PrivacyPortal", [], {
    client: { public: params.publicClient, wallet: params.wallet },
  });
  await portal.write.initialize([params.owner, underlying.address, pToken.address, 18], {
    account: params.owner,
  });

  return {
    viem: params.viem,
    publicClient: params.publicClient,
    wallet: params.wallet,
    owner: params.owner,
    recipient: RECIPIENT,
    underlying,
    pToken,
    portal,
  };
}

export async function fundUserAndApprovePortal(ctx: PortalTestContext, amount: bigint) {
  await ctx.underlying.write.mint([ctx.owner, amount], writeOpts(ctx));
  await ctx.underlying.write.approve([ctx.portal.address, amount], writeOpts(ctx));
}

export async function depositPublicToken(
  ctx: PortalTestContext,
  amount: bigint,
  params: { recipient?: `0x${string}`; fee?: bigint; callbackFee?: bigint } = {}
) {
  await ctx.portal.write.deposit([params.recipient ?? ctx.recipient, amount, params.callbackFee ?? 77n], {
    ...writeOpts(ctx),
    value: params.fee ?? 1_000n,
  });
}

export async function seedPortalVault(ctx: PortalTestContext, amount: bigint) {
  await ctx.underlying.write.mint([ctx.portal.address, amount], writeOpts(ctx));
}

export async function requestWithdraw(
  ctx: PortalTestContext,
  amount: bigint,
  params: { recipient?: `0x${string}`; transferFee?: bigint; burnFee?: bigint } = {}
) {
  const transferFee = params.transferFee ?? DEFAULT_WITHDRAW.transferFee;
  const burnFee = params.burnFee ?? DEFAULT_WITHDRAW.burnFee;
  await ctx.portal.write.requestWithdrawWithPermit(
    [
      params.recipient ?? ctx.recipient,
      amount,
      transferFee,
      DEFAULT_WITHDRAW.transferCallbackFee,
      burnFee,
      DEFAULT_WITHDRAW.burnCallbackFee,
      DEFAULT_WITHDRAW.permitDeadline,
      DEFAULT_WITHDRAW.v,
      DEFAULT_WITHDRAW.r,
      DEFAULT_WITHDRAW.s,
    ],
    { ...writeOpts(ctx), value: transferFee + burnFee }
  );
}

export async function completePTokenTransferCallback(ctx: PortalTestContext) {
  await ctx.pToken.write.triggerLastTransferCallback([], writeOpts(ctx));
}

export async function setBurnSubmissionFailure(ctx: PortalTestContext, shouldFail: boolean) {
  await ctx.pToken.write.setBurnShouldRevert([shouldFail], writeOpts(ctx));
}

export async function burnAccumulatedDebt(ctx: PortalTestContext, amount: bigint) {
  await ctx.portal.write.burnAccumulatedDebt(
    [amount, DEFAULT_WITHDRAW.burnFee, DEFAULT_WITHDRAW.burnCallbackFee],
    { ...writeOpts(ctx), value: DEFAULT_WITHDRAW.burnFee }
  );
}

export async function expectDepositMintSubmitted(
  ctx: PortalTestContext,
  params: { amount: bigint; recipient?: `0x${string}`; fee?: bigint; callbackFee?: bigint }
) {
  assert.equal(await ctx.underlying.read.balanceOf([ctx.portal.address]), params.amount);
  assert.equal(await ctx.pToken.read.lastMintRecipient(), getAddress(params.recipient ?? ctx.recipient));
  assert.equal(await ctx.pToken.read.lastMintAmount(), params.amount);
  assert.equal(await ctx.pToken.read.lastMintValue(), params.fee ?? 1_000n);
  assert.equal(await ctx.pToken.read.lastMintCallbackFee(), params.callbackFee ?? 77n);
}

export async function expectWithdrawTransferSubmitted(ctx: PortalTestContext, amount: bigint) {
  assert.equal(await ctx.pToken.read.lastTransferFrom(), getAddress(ctx.owner));
  assert.equal(await ctx.pToken.read.lastTransferTo(), getAddress(ctx.portal.address));
  assert.equal(await ctx.pToken.read.lastTransferAmount(), amount);
  assert.equal(await ctx.pToken.read.lastTransferValue(), DEFAULT_WITHDRAW.transferFee);
  assert.equal(await ctx.pToken.read.lastTransferCallbackFee(), DEFAULT_WITHDRAW.transferCallbackFee);
  assert.equal(await ctx.portal.read.withdrawalNonce(), 1n);
}

export async function deployPortalFactory(ctx: PortalTestContext) {
  const portalImplementation = await ctx.viem.deployContract("PrivacyPortal", [], {
    client: { public: ctx.publicClient, wallet: ctx.wallet },
  });
  const tokenImplementation = await ctx.viem.deployContract("PodErc20MintableInitializable", [], {
    client: { public: ctx.publicClient, wallet: ctx.wallet },
  });
  return ctx.viem.deployContract(
    "PrivacyPortalFactory",
    [ctx.owner, ctx.owner, 7082400n, tokenImplementation.address, portalImplementation.address],
    { client: { public: ctx.publicClient, wallet: ctx.wallet } }
  );
}

export async function deployFactoryPortalPair(ctx: PortalTestContext) {
  const factory = await deployPortalFactory(ctx);
  const underlying = await ctx.viem.deployContract("MockERC20", ["Second", "SEC"], {
    client: { public: ctx.publicClient, wallet: ctx.wallet },
  });

  await factory.write.createPortal(
    [underlying.address, COTI_SIDE_TOKEN, "Private SEC", "pSEC", 6, ctx.owner],
    writeOpts(ctx)
  );

  const portal = await factory.read.portalForUnderlying([underlying.address]);
  const pToken = await factory.read.pTokenForUnderlying([underlying.address]);
  return { factory, underlying, portal, pToken };
}

export async function deployCotiSideFactory(ctx: PortalTestContext) {
  const implementation = await ctx.viem.deployContract("PodErc20CotiSideInitializable", [], {
    client: { public: ctx.publicClient, wallet: ctx.wallet },
  });
  return ctx.viem.deployContract("PodErc20CotiSideFactory", [ctx.owner, ctx.owner, implementation.address], {
    client: { public: ctx.publicClient, wallet: ctx.wallet },
  });
}

export { zeroAddress };
