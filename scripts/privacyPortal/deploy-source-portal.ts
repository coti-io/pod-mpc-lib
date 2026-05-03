import {
  connectPrivacyPortalNetwork,
  createSourcePortalAndPToken,
  envAddress,
  envString,
  optionalEnvAddress,
} from "./deploy-utils.js";

const main = async () => {
  const ctx = await connectPrivacyPortalNetwork(process.env.SOURCE_NETWORK);
  const factory = envAddress("SOURCE_FACTORY");
  const underlying = envAddress("UNDERLYING_TOKEN");
  const cotiSideToken = envAddress("COTI_SIDE_PTOKEN");
  const name = envString("PTOKEN_NAME");
  const symbol = envString("PTOKEN_SYMBOL");
  const decimals = Number(process.env.PTOKEN_DECIMALS || "18");
  const portalOwner = optionalEnvAddress("PORTAL_OWNER");

  const deployed = await createSourcePortalAndPToken(ctx, {
    factory,
    underlying,
    cotiSideToken,
    name,
    symbol,
    decimals,
    portalOwner,
  });
  console.log("[privacyPortal:deploy-source-portal] deployed", deployed);
};

main().catch((error) => {
  console.error("[privacyPortal:deploy-source-portal] Failed:", error);
  process.exitCode = 1;
});
