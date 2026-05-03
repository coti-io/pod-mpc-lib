import {
  connectPrivacyPortalNetwork,
  DEFAULT_COTI_NETWORK,
  DEFAULT_SOURCE_NETWORK,
  deployCotiFactory,
  deploySourceFactory,
  envBigInt,
  getInboxFromConfig,
  optionalEnvAddress,
} from "./deploy-utils.js";

const main = async () => {
  const sourceNetwork = process.env.SOURCE_NETWORK || DEFAULT_SOURCE_NETWORK;
  const cotiNetwork = process.env.COTI_NETWORK || DEFAULT_COTI_NETWORK;
  const owner = optionalEnvAddress("FACTORY_OWNER");

  const source = await connectPrivacyPortalNetwork(sourceNetwork);
  const coti = await connectPrivacyPortalNetwork(cotiNetwork);
  const sourceInbox = await getInboxFromConfig(source, "source");
  const cotiInbox = await getInboxFromConfig(coti, "coti");
  const cotiChainId = envBigInt("COTI_CHAIN_ID", BigInt(coti.chainId));

  const cotiFactory = await deployCotiFactory(coti, { inbox: cotiInbox, owner });
  const sourceFactory = await deploySourceFactory(source, { inbox: sourceInbox, cotiChainId, owner });

  console.log("[privacyPortal:deploy-factories] deployed", {
    sourceFactory,
    cotiFactory,
  });
};

main().catch((error) => {
  console.error("[privacyPortal:deploy-factories] Failed:", error);
  process.exitCode = 1;
});
