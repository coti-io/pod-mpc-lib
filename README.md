[![image](https://img.shields.io/badge/Visit-COTI%20Website-green?style=for-the-badge&logo=internet-explorer)](https://coti.io/)
[![image](https://img.shields.io/badge/Telegram-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white)](https://telegram.coti.io)
[![image](https://img.shields.io/badge/Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.coti.io)
[![image](https://img.shields.io/badge/X-000000?style=for-the-badge&logo=x&logoColor=white)](https://twitter.coti.io)
[![image](https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white)](https://youtube.coti.io)
[![COTI Website](https://img.shields.io/badge/COTI%20WEBSITE-4CAF50?style=for-the-badge)](https://coti.io)

# COTI PoD Contracts & MPC Library

Smart contracts and Hardhat tooling for **Privacy on Demand (PoD)**: cross-chain Inbox messaging between EVM source chains and COTI, MPC executors, PodLib primitives, Privacy Portal flows, and private token standards.

## Documentation

- [Privacy on Demand docs](https://docs.coti.io/coti-documentation/privacy-on-demand)
- [Interactive PoD architecture (pod.coti.io)](https://pod.coti.io/)
- [PoD pattern guide](contracts/PodPattern.md)

## Main components

### Inbox

Cross-chain request/response messaging between a source EVM chain and COTI. Handles outbound calls, inbound execution, callbacks, and fee accounting.

Key contracts: `Inbox.sol`, `InboxUser.sol`, `InboxMiner.sol`, `InboxFeeManager.sol`

### MPC Executor & PodLib

- **MPC Executor** — COTI-side entry point for pre-defined and custom private MPC methods
- **PodLib** — Source-chain helpers (`PodLib64`, `PodLib128`, `PodLib256`) for common private operations
- **PodUser** — Configuration surface for Inbox, COTI chain, and executor routing
- **MpcAbiCodec** — Encodes encrypted inputs into cross-chain MPC method calls

### Privacy Portal

Deposit and withdraw flows for private pTokens across source chains and COTI. See [Privacy Portal deployment scripts](scripts/privacyPortal/README.md).

### Private tokens

- **pERC20** — Private ERC-20 on COTI with source-chain portal integration
- **ERC-7984** — Confidential token compatibility layer

## Development

```bash
npm install
npm test
```

Deploy and system-test scripts live under `scripts/`. Network configuration is in `hardhat.config.ts` and `deployConfig.json`.

## Related repos

- [coti-contracts](https://github.com/coti-io/coti-contracts) — Core COTI MPC and GC contract library
- [pod-architecture](https://github.com/coti-io/pod-architecture) — Interactive PoD architecture site
- [pod-explorer](https://github.com/coti-io/pod-explorer) — PoD block explorer

---

To report an issue or request a feature, open an [issue](https://github.com/coti-io/pod-mpc-lib/issues/new) in this repository.
