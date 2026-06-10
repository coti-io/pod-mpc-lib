import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { network } from "hardhat";
import type { Address, PublicClient, WalletClient } from "viem";
import { buildInboxSalt, precomputeCreate3Address } from "./createx.js";
import {
  asAddress,
  configureTestnetInboxMinFees,
  deployAndWireTestnetPriceOracle,
  deployDeterministicInbox,
  ensureMinerRegistered,
  getViemClients,
  optionalEnv,
  podConfigureKeepInbox,
  readFeeConfigForChain,
  resolveDeployerAddress,
  waitMined,
} from "./deploy-utils.js";
import {
  explorerAddressUrl,
  hasOnChainCode,
  isVerifiedOnExplorer,
} from "./explorer.js";

const deployConfigPath = path.resolve(process.cwd(), "deployConfig.json");

type Role = "source" | "coti";

/** User-selectable networks (must exist in hardhat.config.ts). */
const DEPLOY_NETWORKS: { name: string; chainId: number; role: Role; label: string }[] = [
  { name: "sepolia", chainId: 11155111, role: "source", label: "Sepolia" },
  { name: "avalancheFuji", chainId: 43113, role: "source", label: "Avalanche Fuji" },
  { name: "cotiTestnet", chainId: 7082400, role: "coti", label: "COTI Testnet" },
];

type DeployCtx = {
  viem: any;
  publicClient: PublicClient;
  walletClient: WalletClient;
  chainId: number;
  networkName: string;
  deployer: Address;
  /** Deterministic CreateX address for the Inbox (known before deploy). */
  inboxAddress: Address;
};

type Target = {
  id: string;
  label: string;
  /** Roles (network kinds) this target applies to. */
  roles: Role[];
  /** Target ids that must be deployed before this one is selectable. */
  dependsOn: string[];
  /**
   * `contract`: deploys + verifies an address-bearing contract.
   * `action`: applies on-chain configuration (no address, no verify).
   */
  kind: "contract" | "action";

  // --- contract-only ---
  contractName?: string;
  /** Key under `deployConfig.chains[chainId]` where the address is stored. */
  configKey?: string;
  /** Recorded/precomputed address (may exist before on-chain deploy). */
  resolveAddress?: (ctx: DeployCtx, chainCfg: Record<string, any>) => Address | undefined;
  /** Deploy (and wire) the contract; returns the deployed address. */
  deploy?: (ctx: DeployCtx) => Promise<Address>;
  /** Constructor args (as strings) passed to `hardhat verify`. */
  verifyArgs?: (ctx: DeployCtx) => string[];

  // --- action-only ---
  /** Report whether on-chain state already matches the desired config. */
  status?: (ctx: DeployCtx) => Promise<{ applied: boolean; detail?: string }>;
  /** Apply the action (idempotent). */
  run?: (ctx: DeployCtx) => Promise<void>;
};

// --- deployConfig.json helpers (flexible shape; preserves unknown keys) ---

const readCfg = async (): Promise<any> => JSON.parse(await fs.readFile(deployConfigPath, "utf8"));
/** Synchronous read used by `verifyArgs` (which must return constructor args synchronously). */
const readCfgSync = (): any => JSON.parse(readFileSync(deployConfigPath, "utf8"));
const writeCfg = async (cfg: any): Promise<void> =>
  fs.writeFile(deployConfigPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
const chainEntry = (cfg: any, chainId: number): Record<string, any> => {
  cfg.chains ??= {};
  cfg.chains[String(chainId)] ??= {};
  return cfg.chains[String(chainId)];
};
const chainCfgSync = (chainId: number): Record<string, any> =>
  readCfgSync().chains?.[String(chainId)] ?? {};

/** Factory owner for PrivacyPortal deployments: `FACTORY_OWNER` env if set, else the deployer. */
const factoryOwner = (ctx: DeployCtx): Address => {
  const raw = optionalEnv("FACTORY_OWNER");
  return raw ? asAddress(raw, "FACTORY_OWNER") : ctx.deployer;
};

const getInbox = (ctx: DeployCtx) =>
  ctx.viem.getContractAt("Inbox", ctx.inboxAddress, {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });

const deploySimple = async (ctx: DeployCtx, name: string, args: unknown[]): Promise<Address> => {
  const c = await ctx.viem.deployContract(name, args, {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });
  return c.address as Address;
};

// --- source-side Pod app COTI routing (MpcAdder -> COTI MpcExecutor) ---

const COTI_TESTNET_CHAIN_ID = 7082400n;
const COTI_MAINNET_CHAIN_ID = 2632500n;

/** COTI chain id a given source chain pairs with (mainnet -> COTI mainnet, otherwise COTI testnet). */
const pairedCotiChainId = (ctx: DeployCtx): bigint =>
  ctx.chainId === 1 ? COTI_MAINNET_CHAIN_ID : COTI_TESTNET_CHAIN_ID;

/** Resolve the COTI chain id this source chain pairs with and its recorded MPC executor address. */
const resolveCotiExecutor = async (
  ctx: DeployCtx
): Promise<{ cotiChainId: bigint; executor?: Address }> => {
  const cotiChainId = ctx.chainId === 1 ? COTI_MAINNET_CHAIN_ID : COTI_TESTNET_CHAIN_ID;
  const cfg = await readCfg();
  const raw: unknown = cfg.chains?.[String(cotiChainId)]?.cotiExecutor;
  const executor =
    typeof raw === "string" && raw.startsWith("0x") && raw.length === 42 ? (raw as Address) : undefined;
  return { cotiChainId, executor };
};

/**
 * Point an already-deployed MpcAdder at the COTI MPC executor (owner-gated `configure`, keeps inbox).
 * Idempotent. Returns false (with a warning) when the executor isn't recorded yet so the caller can
 * preserve the deployed address and let the user re-run the ConfigureAdder action later.
 */
const configureMpcAdder = async (ctx: DeployCtx, adderAddress: Address): Promise<boolean> => {
  const { cotiChainId, executor } = await resolveCotiExecutor(ctx);
  if (!executor) {
    console.warn(
      `  COTI executor not set in deployConfig.chains.${cotiChainId}.cotiExecutor; ` +
        `deploy MpcExecutor on COTI first, then run the ConfigureAdder action.`
    );
    return false;
  }
  const adder = await ctx.viem.getContractAt("MpcAdder", adderAddress, {
    client: { public: ctx.publicClient, wallet: ctx.walletClient },
  });
  const deployer = await resolveDeployerAddress(ctx.walletClient);
  const hash = await adder.write.configure(podConfigureKeepInbox(executor, cotiChainId), {
    account: deployer,
  });
  await waitMined(ctx.publicClient, hash);
  console.log(`  configured MpcAdder -> executor ${executor} (cotiChainId ${cotiChainId})`);
  return true;
};

// --- fee config (read on-chain templates to compare against deployConfig.json) ---

const FEE_FIELDS = [
  "constantFee",
  "gasPerByte",
  "callbackExecutionGas",
  "errorLength",
  "bufferRatioX10000",
] as const;
type FeeTuple = Record<(typeof FEE_FIELDS)[number], bigint>;

/** Normalize the inbox `FeeConfig` getter result (viem returns an array for multi-field struct getters). */
const normalizeFee = (raw: any): FeeTuple => {
  if (Array.isArray(raw)) {
    return {
      constantFee: BigInt(raw[0]),
      gasPerByte: BigInt(raw[1]),
      callbackExecutionGas: BigInt(raw[2]),
      errorLength: BigInt(raw[3]),
      bufferRatioX10000: BigInt(raw[4]),
    };
  }
  return {
    constantFee: BigInt(raw.constantFee),
    gasPerByte: BigInt(raw.gasPerByte),
    callbackExecutionGas: BigInt(raw.callbackExecutionGas),
    errorLength: BigInt(raw.errorLength),
    bufferRatioX10000: BigInt(raw.bufferRatioX10000),
  };
};

const readInboxFeeConfigs = async (inbox: any): Promise<[FeeTuple, FeeTuple]> => {
  const [local, remote] = await Promise.all([
    inbox.read.localMinFeeConfig(),
    inbox.read.remoteMinFeeConfig(),
  ]);
  return [normalizeFee(local), normalizeFee(remote)];
};

const feeEq = (a: FeeTuple, b: Record<string, bigint>): boolean =>
  FEE_FIELDS.every((f) => a[f] === b[f]);

const feeIsZero = (a: FeeTuple): boolean => FEE_FIELDS.every((f) => a[f] === 0n);

// --- PrivacyPortal test-token wiring ---

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** True for a syntactically valid, non-zero address string. */
const isAddr = (v: unknown): v is Address =>
  typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && v.toLowerCase() !== ZERO_ADDRESS;

/**
 * Registry of PrivacyPortal test tokens. Static params live here (single source of truth); the
 * per-source-chain underlying ERC20 and deployed clone addresses are recorded in deployConfig
 * (data-driven). Add a token by appending to `PP_TOKENS`.
 *
 * A COTI-side pToken authorizes exactly one remote peer, so EACH source chain gets its own
 * COTI-side token. deployConfig layout:
 *   chains[<source>].privacyPortalTokens[key]                    = { underlying, portal, pToken }
 *   chains[<coti>].privacyPortalTokens[key].bySource[<source>]   = { cotiSide }
 */
type PpToken = {
  /** deployConfig key under `privacyPortalTokens` and the private pToken identity. */
  key: string;
  /** Private (pToken) name + symbol minted on each source chain. */
  pName: string;
  pSymbol: string;
  /** Shared decimals for the underlying collateral and the pToken. */
  decimals: number;
  /** Public underlying ERC20 name/symbol used when deploying a mock collateral token (testnets). */
  underlyingName: string;
  underlyingSymbol: string;
  /** Source chains this token is wired on; each pairs with its `cotiChainForSource`. */
  sources: number[];
};

/** Short labels for chains used in menu target names. */
const SOURCE_LABEL: Record<number, string> = {
  1: "Eth",
  11155111: "Sep",
  43113: "Avax",
};
const srcLabel = (chainId: number): string => SOURCE_LABEL[chainId] ?? String(chainId);

const PP_TOKENS: PpToken[] = [
  {
    key: "pMTT",
    pName: "Private MyTestToken",
    pSymbol: "pMTT",
    decimals: 18,
    underlyingName: "MyTestToken",
    underlyingSymbol: "MTT",
    sources: [11155111, 43113],
  },
  {
    key: "ptUSDC",
    pName: "Private Test USDC",
    pSymbol: "p.tUSDC",
    decimals: 6,
    underlyingName: "Test USDC",
    underlyingSymbol: "tUSDC",
    sources: [43113],
  },
];

/** COTI chain a given source chain pairs with (mainnet -> COTI mainnet, otherwise COTI testnet). */
const cotiChainForSource = (sourceChainId: number): number =>
  sourceChainId === 1 ? Number(COTI_MAINNET_CHAIN_ID) : Number(COTI_TESTNET_CHAIN_ID);

/** Source-side token entry `{ underlying?, portal?, pToken? }` from deployConfig. */
const readSourceToken = (sourceChainId: number, key: string): Record<string, any> =>
  readCfgSync().chains?.[String(sourceChainId)]?.privacyPortalTokens?.[key] ?? {};

/** COTI-side token entry `{ cotiSide? }` for a given source pairing from deployConfig. */
const readCotiToken = (
  cotiChainId: number | bigint,
  key: string,
  sourceChainId: number
): Record<string, any> =>
  readCfgSync().chains?.[String(cotiChainId)]?.privacyPortalTokens?.[key]?.bySource?.[String(sourceChainId)] ?? {};

/** Persist a field on the source-side token entry under `chains[source].privacyPortalTokens[key]`. */
const recordSourceTokenField = async (
  sourceChainId: number,
  key: string,
  field: string,
  value: string
): Promise<void> => {
  const cfg = await readCfg();
  const entry = chainEntry(cfg, sourceChainId);
  entry.privacyPortalTokens ??= {};
  entry.privacyPortalTokens[key] ??= {};
  entry.privacyPortalTokens[key][field] = value;
  await writeCfg(cfg);
};

/** Persist the COTI-side clone address for a source pairing under `...[key].bySource[source]`. */
const recordCotiTokenField = async (
  cotiChainId: number,
  key: string,
  sourceChainId: number,
  field: string,
  value: string
): Promise<void> => {
  const cfg = await readCfg();
  const entry = chainEntry(cfg, cotiChainId);
  entry.privacyPortalTokens ??= {};
  entry.privacyPortalTokens[key] ??= {};
  entry.privacyPortalTokens[key].bySource ??= {};
  entry.privacyPortalTokens[key].bySource[String(sourceChainId)] ??= {};
  entry.privacyPortalTokens[key].bySource[String(sourceChainId)][field] = value;
  await writeCfg(cfg);
};

/**
 * Build PrivacyPortal wiring targets for every token in `PP_TOKENS`:
 *   - COTI side (per token, per source): a (token + remote) pair, since one COTI-side pToken
 *     authorizes exactly one source peer.
 *   - Source side (per token): an underlying (mock collateral) target and a portal target, each
 *     operating on whichever of the token's source chains is currently connected.
 */
const buildPpTokenTargets = (): Target[] => {
  const targets: Target[] = [];

  for (const t of PP_TOKENS) {
    for (const srcId of t.sources) {
      const cotiChainId = cotiChainForSource(srcId);
      const label = srcLabel(srcId);

      targets.push({
        id: `ppCotiToken:${t.key}:${srcId}`,
        label: `${t.pSymbol} tk-${label}`,
        kind: "action",
        roles: ["coti"],
        dependsOn: ["ppCotiFactory"],
        status: async (ctx) => {
          if (ctx.chainId !== cotiChainId) return { applied: false, detail: `COTI chain ${cotiChainId} only` };
          const existing = readCotiToken(ctx.chainId, t.key, srcId).cotiSide;
          return isAddr(existing)
            ? { applied: true, detail: existing }
            : { applied: false, detail: "not created" };
        },
        run: async (ctx) => {
          if (ctx.chainId !== cotiChainId) throw new Error(`Run on COTI chain ${cotiChainId} (got ${ctx.chainId}).`);
          const existing = readCotiToken(ctx.chainId, t.key, srcId).cotiSide;
          if (isAddr(existing)) {
            console.log(`  ${t.key} COTI-side (${label}) already created: ${existing}`);
            return;
          }
          const factoryAddr = asAddress(chainCfgSync(ctx.chainId).cotiSideFactory, "cotiSideFactory");
          const factory = await ctx.viem.getContractAt("PodErc20CotiSideFactory", factoryAddr, {
            client: { public: ctx.publicClient, wallet: ctx.walletClient },
          });
          const nextIndex = await factory.read.allCotiSideTokensLength();
          const hash = await factory.write.createCotiSideToken([factoryOwner(ctx)], { account: ctx.deployer });
          await waitMined(ctx.publicClient, hash);
          const cotiSide = (await factory.read.allCotiSideTokens([nextIndex])) as Address;
          await recordCotiTokenField(ctx.chainId, t.key, srcId, "cotiSide", cotiSide);
          console.log(`  ${t.key} COTI-side pToken (${label}): ${cotiSide}`);
          console.log(`  Recorded deployConfig.chains.${ctx.chainId}.privacyPortalTokens.${t.key}.bySource.${srcId}.cotiSide`);
        },
      });

      targets.push({
        id: `ppCotiRemote:${t.key}:${srcId}`,
        label: `${t.pSymbol} rm-${label}`,
        kind: "action",
        roles: ["coti"],
        dependsOn: ["ppCotiFactory"],
        status: async (ctx) => {
          if (ctx.chainId !== cotiChainId) return { applied: false, detail: `COTI chain ${cotiChainId} only` };
          const cotiSide = readCotiToken(ctx.chainId, t.key, srcId).cotiSide;
          if (!isAddr(cotiSide)) return { applied: false, detail: `needs ${t.pSymbol} tk-${label}` };
          const sourcePToken = readSourceToken(srcId, t.key).pToken;
          if (!isAddr(sourcePToken)) return { applied: false, detail: `needs ${label} pToken (run portal)` };
          const token = await ctx.viem.getContractAt("PodErc20CotiSide", cotiSide, {
            client: { public: ctx.publicClient, wallet: ctx.walletClient },
          });
          const [curChain, curRemote] = await Promise.all([
            token.read.authorizedRemoteChainId(),
            token.read.authorizedRemoteContract(),
          ]);
          if (BigInt(curChain) === BigInt(srcId) && (curRemote as string).toLowerCase() === sourcePToken.toLowerCase()) {
            return { applied: true, detail: `-> ${srcId}:${sourcePToken}` };
          }
          if (BigInt(curChain) !== 0n) return { applied: false, detail: `differs -> ${curRemote}` };
          return { applied: false, detail: `ready -> ${sourcePToken}` };
        },
        run: async (ctx) => {
          if (ctx.chainId !== cotiChainId) throw new Error(`Run on COTI chain ${cotiChainId} (got ${ctx.chainId}).`);
          const cotiSide = asAddress(
            readCotiToken(ctx.chainId, t.key, srcId).cotiSide,
            `chains.${ctx.chainId}.privacyPortalTokens.${t.key}.bySource.${srcId}.cotiSide`
          );
          const sourcePToken = asAddress(
            readSourceToken(srcId, t.key).pToken,
            `chains.${srcId}.privacyPortalTokens.${t.key}.pToken`
          );
          const token = await ctx.viem.getContractAt("PodErc20CotiSide", cotiSide, {
            client: { public: ctx.publicClient, wallet: ctx.walletClient },
          });
          const [curChain, curRemote] = await Promise.all([
            token.read.authorizedRemoteChainId(),
            token.read.authorizedRemoteContract(),
          ]);
          if (BigInt(curChain) === BigInt(srcId) && (curRemote as string).toLowerCase() === sourcePToken.toLowerCase()) {
            console.log(`  ${t.key} COTI remote (${label}) already configured -> chain ${srcId} pToken ${sourcePToken}`);
            return;
          }
          const hash = await token.write.setAuthorizedRemote([BigInt(srcId), sourcePToken], {
            account: ctx.deployer,
          });
          await waitMined(ctx.publicClient, hash);
          console.log(`  ${t.key} COTI remote (${label}) -> chain ${srcId} pToken ${sourcePToken}`);
        },
      });
    }

    targets.push({
      id: `ppUnderlying:${t.key}`,
      label: `${t.underlyingSymbol} ERC20`,
      kind: "action",
      roles: ["source"],
      dependsOn: [],
      status: async (ctx) => {
        if (!t.sources.includes(ctx.chainId)) return { applied: false, detail: "n/a on this chain" };
        const underlying = readSourceToken(ctx.chainId, t.key).underlying;
        return isAddr(underlying)
          ? { applied: true, detail: underlying }
          : { applied: false, detail: "not deployed (mock)" };
      },
      run: async (ctx) => {
        if (!t.sources.includes(ctx.chainId)) {
          throw new Error(`Chain ${ctx.chainId} is not a configured source for ${t.key}.`);
        }
        const existing = readSourceToken(ctx.chainId, t.key).underlying;
        if (isAddr(existing)) {
          console.log(`  ${t.key} underlying already set: ${existing}`);
          return;
        }
        const addr = await deploySimple(ctx, "MockERC20Decimals", [
          t.underlyingName,
          t.underlyingSymbol,
          t.decimals,
        ]);
        const token = await ctx.viem.getContractAt("MockERC20Decimals", addr, {
          client: { public: ctx.publicClient, wallet: ctx.walletClient },
        });
        const mintAmount = 1_000_000n * 10n ** BigInt(t.decimals);
        const mintHash = await token.write.mint([ctx.deployer, mintAmount], { account: ctx.deployer });
        await waitMined(ctx.publicClient, mintHash);
        await recordSourceTokenField(ctx.chainId, t.key, "underlying", addr);
        console.log(`  ${t.key} underlying (${t.underlyingSymbol}, ${t.decimals}d) deployed: ${addr}`);
        console.log(`  Minted 1,000,000 ${t.underlyingSymbol} to ${ctx.deployer}`);
        console.log(`  Recorded deployConfig.chains.${ctx.chainId}.privacyPortalTokens.${t.key}.underlying`);
      },
    });

    targets.push({
      id: `ppPortal:${t.key}`,
      label: `${t.pSymbol} portal`,
      kind: "action",
      roles: ["source"],
      dependsOn: ["ppPortalFactory"],
      status: async (ctx) => {
        if (!t.sources.includes(ctx.chainId)) return { applied: false, detail: "n/a on this chain" };
        const entry = readSourceToken(ctx.chainId, t.key);
        if (isAddr(entry.portal) && isAddr(entry.pToken)) {
          return { applied: true, detail: `portal ${entry.portal}` };
        }
        if (!isAddr(entry.underlying)) return { applied: false, detail: `set ${t.underlyingSymbol} underlying first` };
        const cotiSide = readCotiToken(pairedCotiChainId(ctx), t.key, ctx.chainId).cotiSide;
        if (!isAddr(cotiSide)) return { applied: false, detail: `needs ${t.pSymbol} tk-${srcLabel(ctx.chainId)} on COTI` };
        return { applied: false, detail: "ready to create" };
      },
      run: async (ctx) => {
        if (!t.sources.includes(ctx.chainId)) {
          throw new Error(`Chain ${ctx.chainId} is not a configured source for ${t.key}.`);
        }
        const entry = readSourceToken(ctx.chainId, t.key);
        const underlying = asAddress(
          entry.underlying,
          `chains.${ctx.chainId}.privacyPortalTokens.${t.key}.underlying`
        );
        const cotiSide = asAddress(
          readCotiToken(pairedCotiChainId(ctx), t.key, ctx.chainId).cotiSide,
          `chains.${pairedCotiChainId(ctx)}.privacyPortalTokens.${t.key}.bySource.${ctx.chainId}.cotiSide`
        );
        const factoryAddr = asAddress(chainCfgSync(ctx.chainId).privacyPortalFactory, "privacyPortalFactory");
        const factory = await ctx.viem.getContractAt("PrivacyPortalFactory", factoryAddr, {
          client: { public: ctx.publicClient, wallet: ctx.walletClient },
        });

        let portal = (await factory.read.portalForUnderlying([underlying])) as Address;
        let pToken = (await factory.read.pTokenForUnderlying([underlying])) as Address;
        if (!isAddr(portal)) {
          const hash = await factory.write.createPortal(
            [underlying, cotiSide, t.pName, t.pSymbol, t.decimals, factoryOwner(ctx)],
            { account: ctx.deployer }
          );
          await waitMined(ctx.publicClient, hash);
          portal = (await factory.read.portalForUnderlying([underlying])) as Address;
          pToken = (await factory.read.pTokenForUnderlying([underlying])) as Address;
        } else {
          console.log(`  ${t.key} portal already exists at factory: ${portal}`);
        }

        await recordSourceTokenField(ctx.chainId, t.key, "portal", portal);
        await recordSourceTokenField(ctx.chainId, t.key, "pToken", pToken);
        console.log(`  ${t.key} (${srcLabel(ctx.chainId)}) portal=${portal} pToken=${pToken}`);
        console.log(`  Recorded deployConfig.chains.${ctx.chainId}.privacyPortalTokens.${t.key}`);
      },
    });
  }

  return targets;
};

// --- Target registry ---

const TARGETS: Target[] = [
  {
    id: "inbox",
    label: "Inbox",
    kind: "contract",
    contractName: "Inbox",
    roles: ["source", "coti"],
    dependsOn: [],
    configKey: "inbox",
    resolveAddress: (ctx) => ctx.inboxAddress,
    deploy: async (ctx) => {
      const { inbox, alreadyDeployed } = await deployDeterministicInbox({
        viem: ctx.viem,
        publicClient: ctx.publicClient,
        walletClient: ctx.walletClient,
      });
      const minerRaw = optionalEnv("MINER_ADDRESS");
      if (minerRaw) {
        const added = await ensureMinerRegistered({
          inbox,
          miner: asAddress(minerRaw, "MINER_ADDRESS"),
          publicClient: ctx.publicClient,
          walletClient: ctx.walletClient,
        });
        console.log(added ? "  miner registered" : "  miner already registered");
      } else {
        console.log("  MINER_ADDRESS not set; skipped addMiner");
      }
      if (alreadyDeployed) console.log("  (inbox already existed at deterministic address)");
      return inbox.address as Address;
    },
    verifyArgs: () => [],
  },
  {
    id: "priceOracle",
    label: "PriceOracle",
    kind: "contract",
    contractName: "PriceOracle",
    roles: ["source", "coti"],
    dependsOn: ["inbox"],
    configKey: "priceOracle",
    resolveAddress: (_ctx, chainCfg) => chainCfg.priceOracle || undefined,
    deploy: async (ctx) => {
      const inbox = await getInbox(ctx);
      const oracle = await deployAndWireTestnetPriceOracle({
        viem: ctx.viem,
        publicClient: ctx.publicClient,
        walletClient: ctx.walletClient,
        chainId: ctx.chainId,
        inbox,
      });
      console.log("  wired oracle into inbox (set min fees via the FeeConfig action)");
      return oracle.address as Address;
    },
    verifyArgs: (ctx) => [ctx.deployer],
  },
  {
    id: "feeConfig",
    label: "FeeConfig",
    kind: "action",
    roles: ["source", "coti"],
    dependsOn: ["inbox"],
    status: async (ctx) => {
      const inbox = await getInbox(ctx);
      const [curLocal, curRemote] = await readInboxFeeConfigs(inbox);
      const { local, remote } = await readFeeConfigForChain(ctx.chainId);
      if (feeEq(curLocal, local) && feeEq(curRemote, remote)) {
        return { applied: true, detail: "matches config" };
      }
      const isSet = !feeIsZero(curLocal) || !feeIsZero(curRemote);
      return { applied: false, detail: isSet ? "differs from config" : "not set" };
    },
    run: async (ctx) => {
      const inbox = await getInbox(ctx);
      await configureTestnetInboxMinFees({
        inbox,
        publicClient: ctx.publicClient,
        walletClient: ctx.walletClient,
        chainId: ctx.chainId,
      });
    },
  },
  {
    id: "mpcExecutor",
    label: "MpcExecutor",
    kind: "contract",
    contractName: "MpcExecutor",
    roles: ["coti"],
    dependsOn: ["inbox"],
    configKey: "cotiExecutor",
    resolveAddress: (_ctx, chainCfg) => chainCfg.cotiExecutor || undefined,
    deploy: (ctx) => deploySimple(ctx, "MpcExecutor", [ctx.inboxAddress]),
    verifyArgs: (ctx) => [ctx.inboxAddress],
  },
  {
    id: "pErc20Coti",
    label: "PErc20Coti",
    kind: "contract",
    contractName: "PErc20Coti",
    roles: ["coti"],
    dependsOn: ["inbox"],
    configKey: "pErc20Coti",
    resolveAddress: (_ctx, chainCfg) => chainCfg.pErc20Coti || undefined,
    deploy: (ctx) => deploySimple(ctx, "PErc20Coti", [ctx.inboxAddress]),
    verifyArgs: (ctx) => [ctx.inboxAddress],
  },
  {
    id: "mpcAdder",
    label: "MpcAdder",
    kind: "contract",
    contractName: "MpcAdder",
    roles: ["source"],
    dependsOn: ["inbox"],
    configKey: "mpcAdder",
    resolveAddress: (_ctx, chainCfg) => chainCfg.mpcAdder || undefined,
    deploy: async (ctx) => {
      const address = await deploySimple(ctx, "MpcAdder", [ctx.inboxAddress]);
      await configureMpcAdder(ctx, address);
      return address;
    },
    verifyArgs: (ctx) => [ctx.inboxAddress],
  },
  {
    id: "configureAdder",
    label: "ConfigureAdder",
    kind: "action",
    roles: ["source"],
    dependsOn: ["mpcAdder"],
    status: async (ctx) => {
      const { cotiChainId, executor } = await resolveCotiExecutor(ctx);
      if (!executor) return { applied: false, detail: `needs COTI executor (chain ${cotiChainId})` };
      // `mpcExecutorAddress` is internal on-chain (no getter), so we can't confirm the current
      // value — surface the intended target and let the user (re-)apply on demand.
      return { applied: false, detail: `ready -> ${executor}` };
    },
    run: async (ctx) => {
      const cfg = await readCfg();
      const adderAddr: unknown = cfg.chains?.[String(ctx.chainId)]?.mpcAdder;
      if (typeof adderAddr !== "string" || !adderAddr) {
        throw new Error(`MpcAdder not recorded for chain ${ctx.chainId}; deploy it first.`);
      }
      const ok = await configureMpcAdder(ctx, adderAddr as Address);
      if (!ok) throw new Error("COTI executor address missing; cannot configure MpcAdder.");
    },
  },
  {
    id: "pErc20",
    label: "PErc20",
    kind: "contract",
    contractName: "PErc20",
    roles: ["source"],
    dependsOn: ["inbox"],
    configKey: "pErc20",
    resolveAddress: (_ctx, chainCfg) => chainCfg.pErc20 || undefined,
    deploy: (ctx) => deploySimple(ctx, "PErc20", [ctx.inboxAddress]),
    verifyArgs: (ctx) => [ctx.inboxAddress],
  },
  {
    id: "millionaire",
    label: "Millionaire",
    kind: "contract",
    contractName: "Millionaire",
    roles: ["source"],
    dependsOn: ["inbox"],
    configKey: "millionaire",
    resolveAddress: (_ctx, chainCfg) => chainCfg.millionaire || undefined,
    deploy: (ctx) => deploySimple(ctx, "Millionaire", [ctx.inboxAddress]),
    verifyArgs: (ctx) => [ctx.inboxAddress],
  },

  // --- PrivacyPortal: COTI side (clone implementation + factory) ---
  {
    id: "ppCotiTokenImpl",
    label: "PpCotiImpl",
    kind: "contract",
    contractName: "PodErc20CotiSideInitializable",
    roles: ["coti"],
    dependsOn: [],
    configKey: "cotiSideImplementation",
    resolveAddress: (_ctx, chainCfg) => chainCfg.cotiSideImplementation || undefined,
    deploy: (ctx) => deploySimple(ctx, "PodErc20CotiSideInitializable", []),
    verifyArgs: () => [],
  },
  {
    id: "ppCotiFactory",
    label: "PpCotiFactory",
    kind: "contract",
    contractName: "PodErc20CotiSideFactory",
    roles: ["coti"],
    dependsOn: ["inbox", "ppCotiTokenImpl"],
    configKey: "cotiSideFactory",
    resolveAddress: (_ctx, chainCfg) => chainCfg.cotiSideFactory || undefined,
    deploy: async (ctx) => {
      const impl = asAddress(chainCfgSync(ctx.chainId).cotiSideImplementation, "cotiSideImplementation");
      return deploySimple(ctx, "PodErc20CotiSideFactory", [factoryOwner(ctx), ctx.inboxAddress, impl]);
    },
    verifyArgs: (ctx) => [factoryOwner(ctx), ctx.inboxAddress, chainCfgSync(ctx.chainId).cotiSideImplementation],
  },

  // --- PrivacyPortal: source side (clone implementations + factory) ---
  {
    id: "ppPortalImpl",
    label: "PpPortalImpl",
    kind: "contract",
    contractName: "PrivacyPortal",
    roles: ["source"],
    dependsOn: [],
    configKey: "portalImplementation",
    resolveAddress: (_ctx, chainCfg) => chainCfg.portalImplementation || undefined,
    deploy: (ctx) => deploySimple(ctx, "PrivacyPortal", []),
    verifyArgs: () => [],
  },
  {
    id: "ppTokenImpl",
    label: "PpTokenImpl",
    kind: "contract",
    contractName: "PodErc20MintableInitializable",
    roles: ["source"],
    dependsOn: [],
    configKey: "podTokenImplementation",
    resolveAddress: (_ctx, chainCfg) => chainCfg.podTokenImplementation || undefined,
    deploy: (ctx) => deploySimple(ctx, "PodErc20MintableInitializable", []),
    verifyArgs: () => [],
  },
  {
    id: "ppPortalFactory",
    label: "PpFactory",
    kind: "contract",
    contractName: "PrivacyPortalFactory",
    roles: ["source"],
    dependsOn: ["inbox", "ppPortalImpl", "ppTokenImpl"],
    configKey: "privacyPortalFactory",
    resolveAddress: (_ctx, chainCfg) => chainCfg.privacyPortalFactory || undefined,
    deploy: async (ctx) => {
      const chainCfg = chainCfgSync(ctx.chainId);
      const portalImpl = asAddress(chainCfg.portalImplementation, "portalImplementation");
      const podTokenImpl = asAddress(chainCfg.podTokenImplementation, "podTokenImplementation");
      return deploySimple(ctx, "PrivacyPortalFactory", [
        factoryOwner(ctx),
        ctx.inboxAddress,
        pairedCotiChainId(ctx),
        podTokenImpl,
        portalImpl,
      ]);
    },
    verifyArgs: (ctx) => {
      const chainCfg = chainCfgSync(ctx.chainId);
      return [
        factoryOwner(ctx),
        ctx.inboxAddress,
        String(pairedCotiChainId(ctx)),
        chainCfg.podTokenImplementation,
        chainCfg.portalImplementation,
      ];
    },
  },

  // --- PrivacyPortal test-token wiring (per token, per source chain; clones via the factories) ---
  ...buildPpTokenTargets(),
];

// --- Status computation ---

type TargetStatus = {
  target: Target;
  // contract fields (deployed=false for actions)
  address?: Address;
  deployed: boolean;
  verified?: boolean;
  // action fields
  applied?: boolean;
  detail?: string;
  blockedBy: string[];
};

const gatherStatuses = async (ctx: DeployCtx, role: Role): Promise<TargetStatus[]> => {
  const cfg = await readCfg();
  const chainCfg = chainEntry(cfg, ctx.chainId);
  const applicable = TARGETS.filter((t) => t.roles.includes(role));
  const order = new Map(applicable.map((t, i) => [t.id, i]));

  // 1) contracts: address + on-chain code
  const contracts = applicable.filter((t) => t.kind === "contract");
  const base = await Promise.all(
    contracts.map(async (target) => {
      const address = target.resolveAddress!(ctx, chainCfg);
      const deployed = address ? await hasOnChainCode(ctx.publicClient, address) : false;
      return { target, address, deployed };
    })
  );
  const deployedById = new Map(base.map((b) => [b.target.id, b.deployed]));

  // 2) verification (only for deployed) in parallel
  const verified = await Promise.all(
    base.map((b) => (b.deployed && b.address ? isVerifiedOnExplorer(ctx.chainId, b.address) : Promise.resolve(undefined)))
  );
  const contractStatuses: TargetStatus[] = base.map((b, i) => ({
    target: b.target,
    address: b.address,
    deployed: b.deployed,
    verified: verified[i],
    blockedBy: b.target.dependsOn.filter((dep) => !deployedById.get(dep)),
  }));

  // 3) actions: gated on contract deps; read on-chain state when unblocked
  const actions = applicable.filter((t) => t.kind === "action");
  const actionStatuses: TargetStatus[] = await Promise.all(
    actions.map(async (target) => {
      const blockedBy = target.dependsOn.filter((dep) => !deployedById.get(dep));
      if (blockedBy.length) return { target, deployed: false, applied: false, blockedBy };
      try {
        const { applied, detail } = await target.status!(ctx);
        return { target, deployed: false, applied, detail, blockedBy };
      } catch {
        return { target, deployed: false, applied: false, detail: "status error", blockedBy };
      }
    })
  );

  return [...contractStatuses, ...actionStatuses].sort(
    (a, b) => order.get(a.target.id)! - order.get(b.target.id)!
  );
};

const renderStatusLabel = (s: TargetStatus): string => {
  const name = s.target.label.padEnd(13);
  if (s.target.kind === "action") {
    const blocked = s.blockedBy.length ? `  (needs: ${s.blockedBy.join(", ")})` : "";
    let state: string;
    if (s.blockedBy.length) state = "blocked";
    else if (s.applied) state = `configured${s.detail ? ` (${s.detail})` : ""}`;
    else state = s.detail ?? "not configured";
    return `${name} [${state}]${blocked}`;
  }
  let state: string;
  if (!s.deployed) state = "not deployed";
  else if (s.verified === true) state = "deployed, verified";
  else if (s.verified === false) state = "deployed, UNVERIFIED";
  else state = "deployed, verify?";
  const addr = s.address ? `  ${s.address}` : "";
  // Only surface a dependency block when the target still needs deploying.
  const blocked = !s.deployed && s.blockedBy.length ? `  (needs: ${s.blockedBy.join(", ")})` : "";
  return `${name} [${state}]${addr}${blocked}`;
};

// --- Interactive keyboard menu ---

type MenuItem<T> = { value: T; label: string; disabled?: boolean };

const interactiveSelect = async <T>(title: string, items: MenuItem<T>[]): Promise<T | undefined> => {
  if (!process.stdin.isTTY) {
    console.log(`\n${title}`);
    items.forEach((it, i) => console.log(`  ${i + 1}. ${it.label}${it.disabled ? "  [blocked]" : ""}`));
    console.log("(non-interactive terminal: run in a TTY to select)\n");
    return undefined;
  }

  return new Promise<T | undefined>((resolve) => {
    let idx = items.findIndex((i) => !i.disabled);
    if (idx < 0) idx = 0;

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const render = () => {
      readline.cursorTo(process.stdout, 0, 0);
      readline.clearScreenDown(process.stdout);
      process.stdout.write(`${title}\n(\u2191/\u2193 move \u00b7 Enter select \u00b7 q quit)\n\n`);
      items.forEach((it, i) => {
        const pointer = i === idx ? "\u276f " : "  ";
        const dim = it.disabled ? "\x1b[2m" : "";
        const hi = i === idx && !it.disabled ? "\x1b[36m" : "";
        process.stdout.write(`${dim}${hi}${pointer}${it.label}\x1b[0m\n`);
      });
    };

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.removeListener("keypress", onKey);
      process.stdin.pause();
    };

    const move = (delta: number) => {
      let n = idx;
      for (let k = 0; k < items.length; k++) {
        n = (n + delta + items.length) % items.length;
        if (!items[n].disabled) {
          idx = n;
          break;
        }
      }
      render();
    };

    const onKey = (_str: string, key: readline.Key) => {
      if (!key) return;
      if (key.name === "up" || key.name === "k") move(-1);
      else if (key.name === "down" || key.name === "j") move(1);
      else if (key.name === "return") {
        const chosen = items[idx];
        cleanup();
        process.stdout.write("\n");
        resolve(chosen && !chosen.disabled ? chosen.value : undefined);
      } else if (key.name === "q" || (key.ctrl && key.name === "c")) {
        cleanup();
        process.stdout.write("\n");
        resolve(undefined);
      }
    };

    process.stdin.on("keypress", onKey);
    render();
  });
};

const pressAnyKey = async (message = "Press any key to return to the menu..."): Promise<void> => {
  if (!process.stdin.isTTY) return;
  process.stdout.write(`\n${message}`);
  return new Promise((resolve) => {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onKey = () => {
      process.stdin.setRawMode(false);
      process.stdin.removeListener("keypress", onKey);
      process.stdin.pause();
      process.stdout.write("\n");
      resolve();
    };
    process.stdin.on("keypress", onKey);
  });
};

// --- verify via hardhat CLI ---

const runHardhat = (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("npx", ["hardhat", ...args], { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`hardhat ${args.join(" ")} (exit ${code})`))));
  });

const verifyContract = async (networkName: string, address: Address, args: string[]) => {
  console.log(`Verifying on explorer: ${address}${args.length ? ` args=[${args.join(", ")}]` : ""}`);
  await runHardhat(["verify", "--network", networkName, address, ...args]);
};

// --- action: deploy (if needed) + verify (if needed) + persist ---

const runTarget = async (ctx: DeployCtx, s: TargetStatus): Promise<void> => {
  const { target } = s;

  if (target.kind === "action") {
    console.log(`\n=== Applying ${target.label} on ${ctx.networkName} ===`);
    await target.run!(ctx);
    console.log(`Applied ${target.label}.`);
    return;
  }

  let address = s.address;

  if (!s.deployed) {
    console.log(`\n=== Deploying ${target.label} on ${ctx.networkName} ===`);
    address = await target.deploy!(ctx);
    const cfg = await readCfg();
    chainEntry(cfg, ctx.chainId)[target.configKey!] = address;
    await writeCfg(cfg);
    console.log(`Deployed ${target.label}: ${address}`);
    console.log(`Recorded deployConfig.chains.${ctx.chainId}.${target.configKey}`);
  } else {
    console.log(`\n=== ${target.label} already deployed at ${address} ===`);
  }

  if (!address) return;

  const verified = await isVerifiedOnExplorer(ctx.chainId, address);
  if (verified === true) {
    console.log(`Already verified: ${explorerAddressUrl(ctx.chainId, address) ?? address}`);
    return;
  }
  try {
    await verifyContract(ctx.networkName, address, target.verifyArgs!(ctx));
    console.log(`Verified: ${explorerAddressUrl(ctx.chainId, address) ?? address}`);
  } catch (error) {
    console.warn(`Verification failed (you can retry later):`, error instanceof Error ? error.message : error);
  }
};

const main = async () => {
  // Optional non-interactive network selection (handy for status checks / CI):
  // `DEPLOY_CLI_NETWORK=avalancheFuji npm run deploy:cli`.
  const envNet = optionalEnv("DEPLOY_CLI_NETWORK");
  let net: (typeof DEPLOY_NETWORKS)[number] | undefined;
  if (envNet) {
    net = DEPLOY_NETWORKS.find((n) => n.name === envNet);
    if (!net) {
      console.error(`Unknown DEPLOY_CLI_NETWORK="${envNet}". Known: ${DEPLOY_NETWORKS.map((n) => n.name).join(", ")}`);
      return;
    }
  } else {
    net = await interactiveSelect(
      "Select a network to deploy to",
      DEPLOY_NETWORKS.map((n) => ({ value: n, label: `${n.label.padEnd(16)} chainId ${n.chainId}  [${n.role}]` }))
    );
  }
  if (!net) {
    console.log("No network selected. Exiting.");
    return;
  }

  console.log(`Connecting to ${net.name}...`);
  const connection = await network.connect({ network: net.name });
  const { viem, provider, networkName } = connection;
  const { chainId, publicClient, walletClient } = await getViemClients(viem, provider, networkName);
  const deployer = await resolveDeployerAddress(walletClient);
  const inboxAddress = await precomputeCreate3Address(publicClient, deployer, buildInboxSalt(deployer));

  const ctx: DeployCtx = {
    viem,
    publicClient,
    walletClient,
    chainId,
    networkName,
    deployer,
    inboxAddress,
  };

  // Non-interactive batch mode: `DEPLOY_CLI_NETWORK=<net> DEPLOY_CLI_TARGETS=id1,id2 npm run deploy:cli`.
  // Runs the listed target ids in order (re-reading status between each so dependency gating and
  // freshly recorded addresses stay accurate). Useful for scripted/CI deploys.
  const targetsEnv = optionalEnv("DEPLOY_CLI_TARGETS");
  if (targetsEnv) {
    const ids = targetsEnv.split(",").map((s) => s.trim()).filter(Boolean);
    console.log(`Batch mode on ${net.label} (chainId ${chainId}) -> ${ids.join(", ")}`);
    for (const id of ids) {
      const statuses = await gatherStatuses(ctx, net.role);
      const s = statuses.find((st) => st.target.id === id);
      if (!s) {
        console.error(`  Unknown target "${id}" for role "${net.role}"; skipping.`);
        continue;
      }
      if (s.blockedBy.length) {
        console.error(`  Target "${id}" blocked by: ${s.blockedBy.join(", ")}; skipping.`);
        continue;
      }
      await runTarget(ctx, s);
    }
    console.log("Batch mode done.");
    return;
  }

  // Main interactive loop: recompute status each pass so dependency gating stays accurate.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    console.log("Reading deployment status (chain + explorer)...");
    const statuses = await gatherStatuses(ctx, net.role);
    const items: MenuItem<TargetStatus | "exit">[] = statuses.map((s) => ({
      value: s,
      // Actions are gated purely by deps; contracts stay selectable once deployed
      // (so they can be re-verified) but are blocked while deps are missing.
      disabled:
        s.target.kind === "action"
          ? s.blockedBy.length > 0
          : !s.deployed && s.blockedBy.length > 0,
      label: renderStatusLabel(s),
    }));
    items.push({ value: "exit", label: "Exit" });

    const title =
      `Deploy menu \u2014 ${net.label} (chainId ${chainId})\n` +
      `deployer ${deployer} \u00b7 inbox(det) ${inboxAddress}`;
    const choice = await interactiveSelect(title, items);
    if (!choice || choice === "exit") {
      console.log("Done.");
      break;
    }
    await runTarget(ctx, choice);
    await pressAnyKey();
  }
};

main().catch((error) => {
  console.error("[deploy-cli] Failed:", error);
  process.exitCode = 1;
});
