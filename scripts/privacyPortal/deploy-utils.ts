import { network } from "hardhat";
import {
  appendDeploymentLog,
  asAddress,
  getChainConfig,
  getViemClients,
  optionalEnv,
  readDeployConfig,
  resolveDeployerAddress,
  waitMined,
} from "../deploy-utils.js";

export type ConnectedNetwork = {
  viem: any;
  chainId: number;
  chainName: string;
  publicClient: any;
  walletClient: any;
  deployer: `0x${string}`;
};

export type SourceFactoryDeployment = {
  portalImplementation: `0x${string}`;
  podTokenImplementation: `0x${string}`;
  factory: `0x${string}`;
};

export type CotiFactoryDeployment = {
  cotiSideImplementation: `0x${string}`;
  factory: `0x${string}`;
};

export type SourcePortalDeployment = {
  portal: `0x${string}`;
  pToken: `0x${string}`;
};

export const DEFAULT_SOURCE_NETWORK = "sepolia";
export const DEFAULT_COTI_NETWORK = "cotiTestnet";

export const connectPrivacyPortalNetwork = async (networkName?: string): Promise<ConnectedNetwork> => {
  const connection = await network.connect(networkName ? { network: networkName } : undefined);
  const { viem, provider, networkName: hardhatNetworkName } = connection;
  const { chainId, chainName, publicClient, walletClient } = await getViemClients(
    viem,
    provider,
    hardhatNetworkName
  );
  const deployer = await resolveDeployerAddress(walletClient);
  console.log(`[privacyPortal] connected network=${chainName} chainId=${chainId} deployer=${deployer}`);
  return { viem, chainId, chainName, publicClient, walletClient, deployer };
};

export const envAddress = (key: string): `0x${string}` => asAddress(process.env[key] ?? "", key);

export const optionalEnvAddress = (key: string): `0x${string}` | undefined => {
  const value = optionalEnv(key);
  return value ? asAddress(value, key) : undefined;
};

export const envBigInt = (key: string, fallback?: bigint): bigint => {
  const value = optionalEnv(key);
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${key}`);
  }
  return BigInt(value);
};

export const envString = (key: string, fallback?: string): string => {
  const value = optionalEnv(key);
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
};

export const getInboxFromConfig = async (ctx: ConnectedNetwork, label: string): Promise<`0x${string}`> => {
  const configured = optionalEnvAddress(`${label.toUpperCase()}_INBOX`) ?? optionalEnvAddress("INBOX");
  if (configured) return configured;

  const deployConfig = await readDeployConfig();
  const chainConfig = getChainConfig(deployConfig, ctx.chainId, label);
  return asAddress(chainConfig.inbox ?? "", `deployConfig.chains.${ctx.chainId}.inbox`);
};

export const deploySourceFactory = async (
  ctx: ConnectedNetwork,
  params: { inbox: `0x${string}`; cotiChainId: bigint; owner?: `0x${string}` }
): Promise<SourceFactoryDeployment> => {
  const owner = params.owner ?? ctx.deployer;
  console.log("[privacyPortal] deploying PrivacyPortal implementation...");
  const portalImplementation = await ctx.viem.deployContract("PrivacyPortal", [], {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });
  console.log(`[privacyPortal] PrivacyPortal implementation=${portalImplementation.address}`);

  console.log("[privacyPortal] deploying PodErc20MintableInitializable implementation...");
  const podTokenImplementation = await ctx.viem.deployContract("PodErc20MintableInitializable", [], {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });
  console.log(`[privacyPortal] PodErc20MintableInitializable implementation=${podTokenImplementation.address}`);

  console.log("[privacyPortal] deploying PrivacyPortalFactory...");
  const factory = await ctx.viem.deployContract(
    "PrivacyPortalFactory",
    [owner, params.inbox, params.cotiChainId, podTokenImplementation.address, portalImplementation.address],
    { client: { public: ctx.publicClient, wallet: ctx.walletClient } }
  );
  console.log(`[privacyPortal] PrivacyPortalFactory=${factory.address}`);

  await logDeployment(ctx, "PrivacyPortal", portalImplementation.address);
  await logDeployment(ctx, "PodErc20MintableInitializable", podTokenImplementation.address);
  await logDeployment(ctx, "PrivacyPortalFactory", factory.address);

  return {
    portalImplementation: portalImplementation.address,
    podTokenImplementation: podTokenImplementation.address,
    factory: factory.address,
  };
};

export const deployCotiFactory = async (
  ctx: ConnectedNetwork,
  params: { inbox: `0x${string}`; owner?: `0x${string}` }
): Promise<CotiFactoryDeployment> => {
  const owner = params.owner ?? ctx.deployer;
  console.log("[privacyPortal] deploying PodErc20CotiSideInitializable implementation...");
  const cotiSideImplementation = await ctx.viem.deployContract("PodErc20CotiSideInitializable", [], {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });
  console.log(`[privacyPortal] PodErc20CotiSideInitializable implementation=${cotiSideImplementation.address}`);

  console.log("[privacyPortal] deploying PodErc20CotiSideFactory...");
  const factory = await ctx.viem.deployContract(
    "PodErc20CotiSideFactory",
    [owner, params.inbox, cotiSideImplementation.address],
    { client: { public: ctx.publicClient, wallet: ctx.walletClient } }
  );
  console.log(`[privacyPortal] PodErc20CotiSideFactory=${factory.address}`);

  await logDeployment(ctx, "PodErc20CotiSideInitializable", cotiSideImplementation.address);
  await logDeployment(ctx, "PodErc20CotiSideFactory", factory.address);

  return { cotiSideImplementation: cotiSideImplementation.address, factory: factory.address };
};

export const createCotiSidePToken = async (
  ctx: ConnectedNetwork,
  params: { factory: `0x${string}`; owner?: `0x${string}` }
): Promise<`0x${string}`> => {
  const owner = params.owner ?? ctx.deployer;
  const factory = await ctx.viem.getContractAt("PodErc20CotiSideFactory", params.factory, {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });
  const nextIndex = await factory.read.allCotiSideTokensLength();

  console.log(`[privacyPortal] creating COTI-side pToken clone with owner=${owner}...`);
  const hash = await factory.write.createCotiSideToken([owner], { account: ctx.deployer });
  await waitMined(ctx.publicClient, hash);
  const cotiSideToken = await factory.read.allCotiSideTokens([nextIndex]);
  console.log(`[privacyPortal] COTI-side pToken=${cotiSideToken}`);

  await logDeployment(ctx, "PodErc20CotiSide", cotiSideToken);
  return cotiSideToken;
};

export const createSourcePortalAndPToken = async (
  ctx: ConnectedNetwork,
  params: {
    factory: `0x${string}`;
    underlying: `0x${string}`;
    cotiSideToken: `0x${string}`;
    name: string;
    symbol: string;
    decimals?: number;
    portalOwner?: `0x${string}`;
  }
): Promise<SourcePortalDeployment> => {
  const portalOwner = params.portalOwner ?? ctx.deployer;
  const decimals = params.decimals ?? 18;
  const factory = await ctx.viem.getContractAt("PrivacyPortalFactory", params.factory, {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });

  console.log(
    `[privacyPortal] creating portal pair underlying=${params.underlying} cotiSideToken=${params.cotiSideToken}...`
  );
  const hash = await factory.write.createPortal(
    [params.underlying, params.cotiSideToken, params.name, params.symbol, decimals, portalOwner],
    { account: ctx.deployer }
  );
  await waitMined(ctx.publicClient, hash);

  const portal = await factory.read.portalForUnderlying([params.underlying]);
  const pToken = await factory.read.pTokenForUnderlying([params.underlying]);
  console.log(`[privacyPortal] PrivacyPortal=${portal}`);
  console.log(`[privacyPortal] PoD pToken=${pToken}`);

  await logDeployment(ctx, "PrivacyPortal", portal);
  await logDeployment(ctx, "PodErc20Mintable", pToken);
  return { portal, pToken };
};

export const configureCotiSideRemote = async (
  ctx: ConnectedNetwork,
  params: { cotiSideToken: `0x${string}`; sourceChainId: bigint; sourcePToken: `0x${string}` }
) => {
  const cotiSideToken = await ctx.viem.getContractAt("PodErc20CotiSide", params.cotiSideToken, {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });
  console.log(
    `[privacyPortal] configuring COTI pToken remote chain=${params.sourceChainId} pToken=${params.sourcePToken}...`
  );
  const hash = await cotiSideToken.write.setAuthorizedRemote(
    [params.sourceChainId, params.sourcePToken],
    { account: ctx.deployer }
  );
  await waitMined(ctx.publicClient, hash);
  console.log("[privacyPortal] COTI pToken remote configured");
};

export const logDeployment = async (ctx: ConnectedNetwork, contract: string, address: `0x${string}`) => {
  await appendDeploymentLog({
    contract,
    address,
    chainId: ctx.chainId,
    network: ctx.chainName,
  });
};
