# PoD Ecosystem — Repository Split

**pod-mpc-lib** has been split into three focused repositories:

| Repository | Contents |
|------------|----------|
| **[coti-pod-inbox-contracts](../coti-pod-inbox-contracts)** | `Inbox`, `InboxMiner`, fee manager, `MpcAbiCodec`, inbox tests |
| **[coti-contracts](../coti-contracts)** | dApps under `contracts/pod/` (Privacy Portal, pERC20, PodLib, examples) |
| **[pod-ecosystem-integration](../pod-ecosystem-integration)** | E2E tests, deploy scripts, multi-repo workspace |

## Migration

- **Inbox work** → `coti-pod-inbox-contracts`
- **dApp contract changes** → `coti-contracts/contracts/pod/`
- **Integration tests & deploy** → `pod-ecosystem-integration`

Open `../pod-ecosystem-integration/pod-ecosystem.code-workspace` in Cursor/VS Code for full-stack development.

## This repo (legacy)

`pod-mpc-lib` remains temporarily for reference. New changes should go to the repos above.

`npm run copy:pod-contracts` is superseded by:

```bash
# From coti-pod-inbox-contracts:
npm run sync:interfaces -- ../coti-contracts
```
