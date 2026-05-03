# Privacy Portal Deployment Scripts

All scripts use the existing Hardhat network config and `deployConfig.json` inbox addresses unless an env override is supplied.

## Factories

```bash
npx hardhat run scripts/privacyPortal/deploy-source-factory.ts --network sepolia
npx hardhat run scripts/privacyPortal/deploy-coti-factory.ts --network cotiTestnet
```

Or deploy both in one command:

```bash
npx hardhat run scripts/privacyPortal/deploy-factories.ts
```

Useful env:

- `SOURCE_NETWORK` defaults to `sepolia`
- `COTI_NETWORK` defaults to `cotiTestnet`
- `FACTORY_OWNER` defaults to deployer
- `SOURCE_INBOX`, `COTI_INBOX`, or `INBOX` override `deployConfig.json`
- `COTI_CHAIN_ID` defaults to the connected COTI chain for two-network scripts

## Per-token Deployment

Deploy only the COTI-side pToken clone:

```bash
COTI_FACTORY=0x... npx hardhat run scripts/privacyPortal/deploy-coti-ptoken.ts --network cotiTestnet
```

Deploy the PoD-side portal and pToken clone for an already deployed COTI-side pToken:

```bash
SOURCE_FACTORY=0x... \
UNDERLYING_TOKEN=0x... \
COTI_SIDE_PTOKEN=0x... \
PTOKEN_NAME="Private USDC" \
PTOKEN_SYMBOL="pUSDC" \
PTOKEN_DECIMALS=6 \
npx hardhat run scripts/privacyPortal/deploy-source-portal.ts --network sepolia
```

Deploy the full token pair in one go. If `SOURCE_FACTORY` or `COTI_FACTORY` is omitted, the script deploys the missing factory first and logs it:

```bash
UNDERLYING_TOKEN=0x... \
PTOKEN_NAME="Private USDC" \
PTOKEN_SYMBOL="pUSDC" \
PTOKEN_DECIMALS=6 \
npx hardhat run scripts/privacyPortal/deploy-token.ts
```

The aggregate script deploys:

- COTI-side pToken clone
- PoD-side `PrivacyPortal` clone
- PoD-side pToken clone
- COTI remote authorization pointing to the PoD pToken

All deployed addresses are printed and appended to `deployment.log`.

## Sync Token List

`PrivacyPortalConfig.json` is the reference config for supported portal tokens. Add tokens under the source network:

```json
{
  "erc20": "0x...",
  "name": "Private USDC",
  "symbol": "pUSDC",
  "decimals": 6,
  "privacyPortal": "",
  "pToken": "",
  "cotiSide": ""
}
```

Then run:

```bash
npm run deploy:privacy:sync
```

The sync script:

- deploys missing source/COTI factories
- deploys missing COTI-side pToken clones
- reads existing source factory mappings when present
- deploys missing source portal + pToken clones
- configures the COTI-side pToken to trust the source pToken
- writes deployed addresses back to `PrivacyPortalConfig.json`

Use `PRIVACY_PORTAL_CONFIG=path/to/file.json` to sync a different config file.
