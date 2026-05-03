import {
  connectPrivacyPortalNetwork,
  deployCotiFactory,
  getInboxFromConfig,
  optionalEnvAddress,
} from "./deploy-utils.js";

const main = async () => {
  const ctx = await connectPrivacyPortalNetwork(process.env.COTI_NETWORK);
  const inbox = await getInboxFromConfig(ctx, "coti");
  const owner = optionalEnvAddress("FACTORY_OWNER");

  const deployed = await deployCotiFactory(ctx, { inbox, owner });
  console.log("[privacyPortal:deploy-coti-factory] deployed", deployed);
};

main().catch((error) => {
  console.error("[privacyPortal:deploy-coti-factory] Failed:", error);
  process.exitCode = 1;
});
