import {
  configureCotiSideRemote,
  connectPrivacyPortalNetwork,
  createCotiSidePToken,
  createSourcePortalAndPToken,
  DEFAULT_COTI_NETWORK,
  DEFAULT_SOURCE_NETWORK,
  deployCotiFactory,
  deploySourceFactory,
  envAddress,
  envBigInt,
  envString,
  getInboxFromConfig,
  optionalEnvAddress,
} from "./deploy-utils.js";

const main = async () => {
  const sourceNetwork = process.env.SOURCE_NETWORK || DEFAULT_SOURCE_NETWORK;
  const cotiNetwork = process.env.COTI_NETWORK || DEFAULT_COTI_NETWORK;
  const underlying = envAddress("UNDERLYING_TOKEN");
  const name = envString("PTOKEN_NAME");
  const symbol = envString("PTOKEN_SYMBOL");
  const decimals = Number(process.env.PTOKEN_DECIMALS || "18");
  const owner = optionalEnvAddress("FACTORY_OWNER");
  const portalOwner = optionalEnvAddress("PORTAL_OWNER");
  const pTokenOwner = optionalEnvAddress("PTOKEN_OWNER");

  const source = await connectPrivacyPortalNetwork(sourceNetwork);
  const coti = await connectPrivacyPortalNetwork(cotiNetwork);

  let cotiFactory = optionalEnvAddress("COTI_FACTORY");
  if (!cotiFactory) {
    const cotiInbox = await getInboxFromConfig(coti, "coti");
    cotiFactory = (await deployCotiFactory(coti, { inbox: cotiInbox, owner })).factory;
  }

  let sourceFactory = optionalEnvAddress("SOURCE_FACTORY");
  if (!sourceFactory) {
    const sourceInbox = await getInboxFromConfig(source, "source");
    const cotiChainId = envBigInt("COTI_CHAIN_ID", BigInt(coti.chainId));
    sourceFactory = (await deploySourceFactory(source, { inbox: sourceInbox, cotiChainId, owner })).factory;
  }

  const cotiSideToken = await createCotiSidePToken(coti, {
    factory: cotiFactory,
    owner: pTokenOwner,
  });

  const sourcePair = await createSourcePortalAndPToken(source, {
    factory: sourceFactory,
    underlying,
    cotiSideToken,
    name,
    symbol,
    decimals,
    portalOwner,
  });

  await configureCotiSideRemote(coti, {
    cotiSideToken,
    sourceChainId: BigInt(source.chainId),
    sourcePToken: sourcePair.pToken,
  });

  console.log("[privacyPortal:deploy-token] deployed", {
    underlying,
    sourceFactory,
    cotiFactory,
    cotiSideToken,
    portal: sourcePair.portal,
    pToken: sourcePair.pToken,
  });
};

main().catch((error) => {
  console.error("[privacyPortal:deploy-token] Failed:", error);
  process.exitCode = 1;
});
