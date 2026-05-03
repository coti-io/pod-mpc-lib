import {
  connectPrivacyPortalNetwork,
  createCotiSidePToken,
  envAddress,
  optionalEnvAddress,
} from "./deploy-utils.js";

const main = async () => {
  const ctx = await connectPrivacyPortalNetwork(process.env.COTI_NETWORK);
  const factory = envAddress("COTI_FACTORY");
  const owner = optionalEnvAddress("PTOKEN_OWNER");

  const cotiSideToken = await createCotiSidePToken(ctx, { factory, owner });
  console.log("[privacyPortal:deploy-coti-ptoken] deployed", { cotiSideToken });
};

main().catch((error) => {
  console.error("[privacyPortal:deploy-coti-ptoken] Failed:", error);
  process.exitCode = 1;
});
