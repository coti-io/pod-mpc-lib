# PoD MPC Library Smart Contract Audit Report

Generated: 2026-05-06

## Scope

This is a static security review of production Solidity contracts under `contracts/`, following `ai_audit/v2/audit.md`.

Reviewed production contracts:

- `contracts/Inbox.sol`
- `contracts/InboxBase.sol`
- `contracts/InboxMiner.sol`
- `contracts/InboxUser.sol`
- `contracts/InboxUserCotiTestnet.sol`
- `contracts/IInbox.sol`
- `contracts/IInboxMiner.sol`
- `contracts/MinerBase.sol`
- `contracts/fee/InboxFeeManager.sol`
- `contracts/fee/PriceOracle.sol`
- `contracts/fee/uniswap/UniswapPriceOracle.sol`
- `contracts/mpc/PodLib.sol`
- `contracts/mpc/PodLib64.sol`
- `contracts/mpc/PodLib128.sol`
- `contracts/mpc/PodLib256.sol`
- `contracts/mpc/PodLibBase.sol`
- `contracts/mpc/PodUser.sol`
- `contracts/mpc/PodUserSepolia.sol`
- `contracts/mpc/coti-side/IPodExecutorOps.sol`
- `contracts/mpc/coti-side/MpcExecutor.sol`
- `contracts/mpccodec/MpcAbiCodec.sol`
- `contracts/privacy/IPrivacyPortal.sol`
- `contracts/privacy/PodErc20CotiSideFactory.sol`
- `contracts/privacy/PrivacyPortal.sol`
- `contracts/privacy/PrivacyPortalFactory.sol`
- `contracts/token/perc20/IPodERC20.sol`
- `contracts/token/perc20/PodERC20.sol`
- `contracts/token/perc20/PodErc20Mintable.sol`
- `contracts/token/perc20/PodErc20MintableInitializable.sol`
- `contracts/token/perc20/cotiside/IPodErc20CotiSide.sol`
- `contracts/token/perc20/cotiside/PodErc20CotiSide.sol`
- `contracts/token/perc20/cotiside/PodErc20CotiSideInitializable.sol`

Excluded as test, example, mock, or harness code:

- `contracts/examples/**`
- `contracts/test/**`
- `contracts/mocks/**`
- `contracts/mpc/coti-side/MpcExecutorCotiTest.sol`
- `contracts/mpc/coti-side/MpcExecutorCotiProxyInbox.sol`
- `contracts/token/perc20/cotiside/PodErc20CotiSideCodecHarness.sol`

No automated dynamic exploit testing or formal verification was performed.

## Summary of Highest Risk Issues

No Critical issues were identified in this static review.

The highest risk areas are:

- Cross-chain fee budgets are derived from `tx.gasprice`, which can underprice remote/callback execution relative to actual execution costs.
- Privacy portal bridge flows can leave user funds stranded if asynchronous pToken mint/transfer callbacks fail after public assets or private balances have already moved.
- `InboxBase.respond` and `InboxBase.raise` allow any contract in the active target call stack to consume the one-shot response channel.
- Fee conversion depends on spot Uniswap V2 reserve prices and privileged oracle administration.
- 128-bit and 256-bit MPC multiplication uses wrapping semantics, which can silently produce incorrect results if callers expect checked arithmetic.

## Findings

### Critical

No Critical findings.

### High

#### H-01: Fee budgets are derived from `tx.gasprice`

Affected contracts:

- `contracts/fee/InboxFeeManager.sol`
- `contracts/InboxBase.sol`

`validateAndPrepareTwoWayFees` and `validateAndPrepareOneWayFees` convert native token payments into stored gas-unit budgets by dividing `msg.value` slices by `tx.gasprice`. The resulting `targetFee` and `callerFee` are then treated as execution gas budgets for remote message execution and callbacks.

Impact:

The fee model depends on the user's transaction gas price, not a protocol-defined gas-price oracle or bounded reference value. When a chain allows low effective gas prices, or when private/orderflow paths are available, a sender can receive a large gas-unit budget for comparatively little native-token payment. This weakens the economics of cross-chain execution, can underfund miners/relayers, and can make DoS or spam cheaper than intended.

Attack scenario:

An attacker submits many messages with minimal effective `tx.gasprice` during a low-base-fee period. Each message passes minimum gas-unit checks because `callbackFeeLocalWei / tx.gasprice` and `remoteGasWei / tx.gasprice` are inflated. Relayers then see messages with large promised gas budgets that were not economically prepaid at realistic execution prices.

Recommendation:

Use a committed fee conversion model independent of the caller's transaction gas price. Options include an owner-set minimum gas price, a bounded gas-price oracle, chain-specific fee schedules, or direct wei-denominated accounting. Add tests that compare paid value, stored budget, and execution reimbursement under low, normal, and high gas-price conditions.

#### H-02: pToken transfer callback failures can strand withdrawals after private balances move

Affected contracts:

- `contracts/token/perc20/PodERC20.sol`
- `contracts/privacy/PrivacyPortal.sol`

`PodERC20.transferCallback` applies the COTI-side balance update, clears pending transfer flags, emits `Transfer`, and then invokes optional callback data with `address(to).call(callbackData)`. If that call fails, the contract only emits `RequestCallbackFailed`; it does not revert the already applied pToken state and does not provide a retry method.

The portal withdrawal flow relies on this callback to call `PrivacyPortal.onPTokenTransferred`, which releases the underlying ERC20 to the recipient.

Impact:

The private pToken transfer to the portal can complete while the underlying-token release callback fails. In that state, the user's pTokens have moved, the transfer is no longer pending, but the public collateral remains locked in the portal. There is no direct portal or pToken retry path to complete the release for the same `withdrawalId`.

Attack scenario:

A user requests withdrawal and the COTI-side transfer succeeds. The callback to `PrivacyPortal.onPTokenTransferred` reverts because the callback runs out of gas, the portal is misconfigured, or a non-standard underlying token makes the portal release path revert. `PodERC20` records the transfer success and only emits `RequestCallbackFailed`, leaving the user without the released underlying.

Recommendation:

Make trusted bridge callbacks atomic with the private transfer, or add an explicit retry/claim path that can re-execute a failed callback for the original request. For portal withdrawals, consider storing callback failure state and allowing the user or keeper to retry `onPTokenTransferred` once the pToken transfer proof is known.

#### H-03: Deposits can lock underlying tokens if asynchronous minting fails

Affected contracts:

- `contracts/privacy/PrivacyPortal.sol`
- `contracts/token/perc20/PodERC20.sol`
- `contracts/token/perc20/cotiside/PodErc20CotiSide.sol`

`PrivacyPortal.deposit` transfers underlying ERC20 tokens into the portal and submits an asynchronous pToken mint request. The underlying transfer is atomic only with submitting the inbox request, not with eventual COTI-side mint success. If the remote mint later fails, `PodERC20.transferError` records the failed request, but the portal has no deposit record, refund path, or retry path tied to the locked underlying.

Impact:

Users can lose access to their public ERC20 collateral without receiving private pTokens when remote minting fails due to misconfiguration, authorized-remote mistakes, inbox/miner errors, insufficient remote execution budget, or unexpected COTI-side failures.

Attack scenario:

A deployer creates a portal before configuring `PodErc20CotiSide.authorizedRemoteContract`, or a miner routes the request to a failing remote target. Users deposit underlying tokens. The pToken mint request fails asynchronously, leaving only a failed pToken request record while the underlying remains in `PrivacyPortal`.

Recommendation:

Track deposits by mint `requestId` and add a refund or retry flow for failed mints. A safe pattern is to keep each deposit in `MintPending` until the pToken mint callback confirms success, then mark it settled. On failure, allow the depositor or an operator to refund the underlying or resubmit the mint.

ANSWER:
- This can be ignored, because we have retry option on inbox to retry the mint if it was because of gas issues. The mint should never fail, on the coti side otherwise.

### Medium

#### M-01: `respond` and `raise` are not restricted to the active target contract

Affected contract:

- `contracts/InboxBase.sol`

During incoming request execution, `respond` and `raise` only check that `_currentContext` is active and that a response has not already been sent. They do not require `msg.sender` to equal the `incomingRequest.targetContract`.

Impact:

Any contract called by the target during request execution can consume the one-shot response channel before the legitimate target responds. This can corrupt callbacks, cause incorrect error routing, or block the intended response.

Attack scenario:

An application target receives a cross-chain request and calls an untrusted router before calling `inbox.respond`. The router calls `Inbox.respond` with malicious bytes. `inboxResponses[incomingRequestId]` is now set, so the target's later legitimate response reverts with `Inbox: reply already sent`.

ANSWER:
- Greate catch! A real potential volnurability!

Recommendation:

Require `msg.sender == incomingRequest.targetContract` in `respond` and `raise`, or introduce an explicit delegated responder mechanism. Document that target contracts must not call untrusted external code before responding until this is fixed.

#### M-02: Mined request IDs are not checked against the provided source chain

Affected contract:

- `contracts/InboxMiner.sol`

`batchProcessRequests` receives `sourceChainId` and each `MinedRequest.requestId`. It unpacks only the nonce from `requestId` and never checks that the high 128-bit chain ID embedded in the request ID equals `sourceChainId`.

Impact:

Incoming request identity can disagree with the execution context returned by `inboxMsgSender`. Integrators that rely on request IDs encoding origin chain can make incorrect assumptions. A malicious or faulty miner can also mix request IDs from a different chain namespace into a batch for `sourceChainId`.

Attack scenario:

A miner processes a batch under `sourceChainId = A` containing request IDs whose packed chain ID is `B`. Target contracts see `inboxMsgSender().chainId == A`, while off-chain systems decode the request ID as chain `B`, causing inconsistent accounting, monitoring, or replay protections.

Recommendation:

Unpack both fields and require `unpackedChainId == sourceChainId` before accepting each mined request.

- ANSWER: Good point. Let's do this.

#### M-03: Spot Uniswap V2 reserves can manipulate fee conversion

Affected contracts:

- `contracts/fee/uniswap/UniswapPriceOracle.sol`
- `contracts/fee/PriceOracle.sol`
- `contracts/fee/InboxFeeManager.sol`

`UniswapPriceOracle` reads current Uniswap V2 reserves and stores spot prices. `InboxFeeManager` uses those cached local/remote token prices to convert fee payments into remote gas budgets.

Impact:

Spot reserves are manipulable, especially in thin pools. Attackers can move prices before `fetchPrices`, causing later messages to be undercharged or overcharged. Because `PriceOracle` also allows a `priceAdmin` to set prices directly, fee conversion is additionally dependent on privileged operational trust.

Attack scenario:

An attacker manipulates a local or remote token pair, calls or waits for `fetchPrices`, and then sends messages while the cached price ratio is distorted. The protocol grants remote execution budgets that do not match the true economic cost.

Recommendation:

Use a TWAP, Chainlink-style feed, bounded price updates, or governance-delayed price changes. Add sanity bounds on price movement and non-zero price checks.

ANSWER: This will only apply to fees. The impact of such attack is minimal, may only cause paying a little less fess for the user. If they attck to cause users pay more fees, then it benefits coti not the attacker. So I would say we keep this as deisgned.

#### M-04: Public fee estimator mixes gas units and wei

Affected contract:

- `contracts/fee/InboxFeeManager.sol`

`calculateTwoWayFeeRequired` mixes terms already multiplied by `gasPrice` with raw gas-unit terms. In the non-constant remote branch, it adds `remoteMethodExecutionGas * gasPrice` to an `expectedMinFee` gas-unit value, then multiplies the sum by `gasPrice` again.

Impact:

The public fee estimator can return materially wrong quotes. Integrators and users may overpay, underpay, or submit transactions that revert even though the UI suggested the fee was sufficient.

Attack scenario:

A wallet uses `calculateTwoWayFeeRequiredInLocalToken` to quote a pToken operation. Because the returned estimate has inconsistent dimensions, the user submits an amount that does not match `validateAndPrepareTwoWayFees`, causing failed transactions or unexpected fee requirements.

Recommendation:

Redesign the estimator around one unit system. Return wei-denominated totals and document the conversion. Add tests that compare estimator outputs against `validateAndPrepareTwoWayFees`.

- ANSWER: Removing calculateTwoWayFeeRequired. Keeping public things only in localToken

#### M-05: `retryFailedRequest` uses uncapped gas while first execution is capped

Affected contract:

- `contracts/InboxMiner.sol`

Initial request execution calls the target with `targetContract.call{gas: targetGasBudget}(callData)`. Retrying a failed request calls `targetContract.call(callData)` with all remaining gas.

Impact:

Retry execution semantics differ from first execution. A request that failed because it exceeded its paid gas budget may succeed on retry at the caller's expense, or a malicious target may consume far more gas during retry than the original budget allowed. This weakens the meaning of `targetFee` and can surprise operators.

Attack scenario:

A target is written so that it intentionally runs out of gas under the original `targetGasBudget`, then succeeds only when retried with a much larger transaction gas limit. This bypasses the original fee budget constraint.

Recommendation:

Retry with the same computed execution budget, or explicitly require a new paid retry budget and store it in the request.

- ANSWER: This is by design. In case the gas calculation was wrong, the retry can skip that. User is not expected to rely on the gasLimit for their contract logic

#### M-06: Wrapping MPC multiplication can silently corrupt economic calculations

Affected contract:

- `contracts/mpc/coti-side/MpcExecutor.sol`

`mul64` uses `MpcCore.checkedMul`, but `mul128`, `mul128FromPlain`, `mul256`, and `mul256FromPlain` use wrapping `MpcCore.mul`. Comments document this behavior, but the externally exposed executor methods are named as normal multiplication and are likely to be reused by application code.

Impact:

If a caller expects checked arithmetic, overflow silently wraps modulo `2^128` or `2^256`. This can corrupt private balances, comparisons, rates, or application-specific accounting that consumes the returned ciphertext.

Attack scenario:

An MPC application computes a private price or balance product that should overflow and fail. Instead, the result wraps to a small value, allowing downstream logic to make an incorrect transfer, comparison, or settlement decision.

Recommendation:

Expose checked and wrapping operations under distinct names, use checked multiplication where required, and document explicit invariants for application code using wrapping multiplication.

- ANWER: ok. will do

#### M-07: COTI-side `ownerMint` can desynchronize supply assumptions

Affected contract:

- `contracts/token/perc20/cotiside/PodErc20CotiSide.sol`

`ownerMint` lets the owner directly increase a COTI-side ciphertext balance without going through the PoD-side pToken mint flow and without updating `PodERC20.totalSupply`.

Impact:

Operator use of `ownerMint` can break supply parity assumptions between the public PoD pToken contract, the COTI-side private ledger, and locked collateral in the privacy portal.

Attack scenario:

A compromised or mistaken owner mints COTI-side balances to an account. The account can then sync and use balances that were never backed by a portal deposit or reflected in PoD-side supply accounting.

Recommendation:

Remove `ownerMint` from production deployments, restrict it behind multisig/timelock governance, or add explicit supply synchronization and monitoring invariants.

- ANSWER: By design. User can call syncBalances. We don't track totalSupply

#### M-08: Clone initializers are permissionless if clones are ever left uninitialized

Affected contracts:

- `contracts/token/perc20/PodErc20MintableInitializable.sol`
- `contracts/token/perc20/cotiside/PodErc20CotiSideInitializable.sol`
- `contracts/privacy/PrivacyPortal.sol`

The clone initializer functions are externally callable and use "first call wins" initialization guards. The current factories clone and initialize in a single transaction, which is safe for the intended path, but any future deployment path that leaves a clone uninitialized can be front-run.

Impact:

An attacker can initialize an uninitialized clone with attacker-controlled inbox, owner, minter, or remote contract parameters.

Attack scenario:

A script deploys clones first and initializes later in a second transaction. An attacker observes the clone address and initializes the pToken with the attacker's minter and COTI-side peer before the deployer.

Recommendation:

Keep clone and initialize atomic. If non-atomic deployment is needed, add access-controlled initializers or deterministic deployment with guarded setup.

- ANSWER: We only deploy through factory

### Low

#### L-01: External call before final state update in `onPTokenTransferred`

Affected contract:

- `contracts/privacy/PrivacyPortal.sol`

`onPTokenTransferred` transfers underlying ERC20 tokens before setting `withdrawal.status = Released`.

Impact:

For standard ERC20s this is low risk because the callback itself is restricted to `pToken`. With non-standard tokens that invoke hooks or arbitrary callbacks, reentrancy can observe the withdrawal as still pending during the token transfer.

Recommendation:

Follow checks-effects-interactions by setting `withdrawal.status = Released` before `safeTransfer`, or explicitly restrict supported underlying tokens to audited non-callback ERC20s.

- ANSWER: will do

#### L-02: Production paths import and execute `hardhat/console.sol`

Affected contracts:

- `contracts/InboxBase.sol`
- `contracts/fee/InboxFeeManager.sol`

Production send and fee-validation paths import `hardhat/console.sol` and call `console.log`.

Impact:

Debug logging increases bytecode size and runtime gas in critical paths, and it is inappropriate for production deployments. Depending on tooling and network assumptions, it may also complicate verification and deployment.

Recommendation:

Remove `hardhat/console.sol` imports and all `console.log` calls from production contracts.

- ANSWER: will do

#### L-03: `send*Message` couples user sends to oracle refresh

Affected contract:

- `contracts/InboxBase.sol`

`sendTwoWayMessage` and `sendOneWayMessage` call `priceOracle.fetchPrices()` after creating the outbound request. If `fetchPrices` reverts, the entire send reverts.

Impact:

Oracle or pair failures can DoS message submission. Although the transaction reverts atomically, users cannot send messages while the oracle refresh path is broken.

Recommendation:

Move price refreshes to a keeper/pull path or wrap refresh in a bounded non-critical mechanism. Validate that cached prices are fresh enough before send if freshness is required.

- ASNWER: by deisgn. To automate the sync.

#### L-04: `fetchBlockInterval` is configured but unused

Affected contract:

- `contracts/fee/PriceOracle.sol`

`fetchBlockInterval` can be set, but `_fetchIntervalsElapsed` only checks elapsed seconds.

Impact:

Operators may believe a block-based update throttle is enforced when it is not.

Recommendation:

Implement the block interval check and track the last fetch block, or remove the variable and setter.

- ASNWERS: do

#### L-05: `pauseController` is immutable after portal initialization

Affected contract:

- `contracts/privacy/PrivacyPortal.sol`

`pauseController` is set to `msg.sender` during `initialize` and cannot be changed.

Impact:

If the factory, pause policy, or controller address changes, existing portals cannot update their withdrawal pause source.

Recommendation:

Add an owner-only setter with an event, or document that pause control is permanently tied to the initializer.

- ANSWER: will do

#### L-06: ETH can accumulate in contracts with unrestricted `receive`

Affected contracts:

- `contracts/privacy/PrivacyPortal.sol`
- `contracts/token/perc20/PodERC20.sol`
- `contracts/mpc/PodLibBase.sol`

These contracts accept arbitrary ETH. Some flows intentionally use contract balance for fees, but arbitrary donations can create accounting confusion.

Impact:

Dust or accidental transfers can become stuck or can subsidize later operations in ways off-chain accounting may not expect.

Recommendation:

Document the funding model and add owner sweep functions where appropriate.

- ANSWER: do

#### L-07: Unbounded factory token array can become expensive to enumerate

Affected contract:

- `contracts/privacy/PodErc20CotiSideFactory.sol`

`allCotiSideTokens` grows forever.

Impact:

Full enumeration becomes increasingly expensive for on-chain callers and heavy for off-chain indexers relying on direct array reads.

Recommendation:

Prefer event indexing or add paginated getters if on-chain consumers need enumeration.

- ANSWER: do

### Informational

#### I-01: Admin and miner roles are highly trusted

Affected contracts:

- `contracts/InboxMiner.sol`
- `contracts/MinerBase.sol`
- `contracts/fee/PriceOracle.sol`
- `contracts/privacy/PrivacyPortalFactory.sol`
- `contracts/privacy/PodErc20CotiSideFactory.sol`
- `contracts/mpc/PodUser.sol`
- `contracts/token/perc20/cotiside/PodErc20CotiSide.sol`

Owners and miners can configure miners, price oracles, deployers, COTI remote peers, implementations, pause state, and MPC executor routing. This is a central trust assumption rather than an implementation bug.

Recommendation:

Use multisig/timelock governance for production roles, emit and monitor all configuration changes, and document the byzantine miner and compromised-admin threat model.

#### I-02: Random MPC executor methods return plaintext

Affected contract:

- `contracts/mpc/coti-side/MpcExecutor.sol`

`rand64`, `rand128`, `rand256`, and bounded variants decrypt random values and respond with `abi.encode(uint256)`.

Impact:

The random values are public on the response path. This is acceptable for public randomness, but unsafe if integrators assume hidden randomness.

Recommendation:

Document these methods as public randomness only. Do not use them as secret seeds unless randomness remains inside MPC or is re-encrypted before exposure.

- ANSWER: By design. Contracts on Eth side cannot decode encrypted data

#### I-03: Public amount paths reveal amounts

Affected contracts:

- `contracts/token/perc20/PodERC20.sol`
- `contracts/token/perc20/cotiside/PodErc20CotiSide.sol`
- `contracts/privacy/PrivacyPortal.sol`

Plain `uint256` transfer, mint, burn, deposit, and withdrawal paths expose amounts in calldata and events.

Recommendation:

Clearly document privacy limitations of public amount flows and route privacy-sensitive use cases through encrypted amount APIs where available.

- ASNWER: do

#### I-04: NatSpec contains stale or misleading statements

Affected contracts:

- `contracts/token/perc20/PodERC20.sol`
- `contracts/token/perc20/PodErc20Mintable.sol`

`PodERC20` mentions `setPublicAmountsEnabled`, which does not exist. `PodErc20Mintable` documentation should be checked for consistency with zero-address minter behavior.

Recommendation:

Update documentation to match implementation.

- ANSWER: Re-do all the NatSpec

#### I-05: Interfaces and inheritance-only libraries have no direct runtime risk

Affected contracts:

- `contracts/IInbox.sol`
- `contracts/IInboxMiner.sol`
- `contracts/mpc/coti-side/IPodExecutorOps.sol`
- `contracts/privacy/IPrivacyPortal.sol`
- `contracts/token/perc20/IPodERC20.sol`
- `contracts/token/perc20/cotiside/IPodErc20CotiSide.sol`
- `contracts/mpc/PodLib.sol`

These files are declarations or inheritance composition. Risks arise from implementing contracts and inherited behavior.

## Security Checklist

| Checklist item | Status | Notes |
|---|---|---|
| Reentrancy | ⚠️ Potentially vulnerable | No direct fund-draining reentrancy found, but `PrivacyPortal.onPTokenTransferred` performs an external token transfer before final status update. `respond`/`raise` can also be consumed by reentrant/untrusted calls during active inbox execution. |
| Access control | ⚠️ Potentially vulnerable | Most sensitive functions use `onlyOwner`, `onlyMiner`, `onlyInbox`, or peer checks. Risks remain around `respond`/`raise` not binding to the target contract and broad admin/miner trust. |
| Arithmetic issues | ⚠️ Potentially vulnerable | Solidity 0.8 checked arithmetic is used for native operations. MPC `mul128` and `mul256` intentionally wrap and can be unsafe for callers expecting checked arithmetic. |
| External calls and interactions | ⚠️ Potentially vulnerable | Cross-chain inbox calls, `inbox.respond`, `inbox.raise`, arbitrary target calls, oracle refreshes, and pToken callback calls are core trust boundaries. Failed pToken callbacks can strand withdrawals. |
| Denial of Service | ⚠️ Potentially vulnerable | Oracle refresh can block sends, fee underpricing can encourage spam, failed async bridge operations can strand assets, and large mined batches or sync batches can stress gas limits. |
| Front-running / MEV | ⚠️ Potentially vulnerable | Public sends/deposits/withdrawals are observable. Spot oracle updates and permissionless first-call initializers are sensitive to ordering if deployment is not atomic. |
| Oracle manipulation | ⚠️ Potentially vulnerable | `UniswapPriceOracle` uses spot V2 reserves and `PriceOracle` has privileged manual price administration. |
| Randomness weaknesses | ⚠️ Potentially vulnerable | Random executor methods return plaintext and must not be treated as hidden randomness. |
| Upgradeability and storage layout collisions | N/A Not applicable | No proxy upgrade pattern was found in production scope. Clone initializers are used, but there is no upgradeable storage-layout inheritance chain beyond clone setup. |
| Authentication (`msg.sender` vs `tx.origin`) | ✅ Safe | No `tx.origin` authorization found. |
| Signature replay / permit issues | ✅ Safe | Public transfer permit binds owner, spender, recipient, amount, nonce, deadline, chain ID, and verifying contract. ERC-1271 smart wallet signatures are not supported. |
| Initialization bugs | ⚠️ Potentially vulnerable | Factory clone-and-initialize is atomic, but initializers are permissionless if any clone is left uninitialized. Oracle price setup is also operationally required before fee validation works correctly. |
| Event logging correctness | ⚠️ Potentially vulnerable | Core events exist, but some failure handling depends on off-chain monitoring of events such as `RequestCallbackFailed`, `BurnDebtRecorded`, and pToken failed requests. |
| Input validation and edge cases | ⚠️ Potentially vulnerable | Many zero-address and amount checks exist. Missing `requestId` chain validation in `InboxMiner` and missing async deposit/withdrawal recovery paths are notable gaps. |
| Gas griefing / block gas limit risks | ⚠️ Potentially vulnerable | Fee conversion can underprice budgets, retry uses uncapped gas, debug logs increase gas, and batch/sync arrays can grow. |
| Centralization / admin abuse risks | ⚠️ Potentially vulnerable | Owners, deployers, miners, oracle admins, portal owners, and COTI token owners are highly trusted. |

## Recommended Fix Checklist

- [ ] Replace `tx.gasprice`-based fee conversion with a bounded or oracle-backed protocol gas-price model.
- [ ] Add recovery or retry paths for failed `transferAndCall` callbacks used by portal withdrawals.
- [ ] Track portal deposits by mint request and support refund or retry when asynchronous pToken minting fails.
- [ ] Require `msg.sender == incomingRequest.targetContract` in `InboxBase.respond` and `InboxBase.raise`, or add explicit delegated responder authorization.
- [ ] Validate that unpacked `requestId` chain ID equals `sourceChainId` in `InboxMiner.batchProcessRequests`.
- [ ] Replace spot Uniswap V2 pricing with TWAP/trusted feeds or enforce bounded price updates.
- [ ] Fix `calculateTwoWayFeeRequired` and add tests comparing quote helpers to validation paths.
- [ ] Align `retryFailedRequest` gas semantics with first execution or require a paid retry budget.
- [ ] Separate checked and wrapping MPC multiplication APIs, and document application-level invariants.
- [ ] Remove `hardhat/console.sol` from production contracts.
- [ ] Move oracle refresh out of user send paths or make it non-critical.
- [ ] Reorder `PrivacyPortal.onPTokenTransferred` to follow checks-effects-interactions.
- [ ] Add or document production governance controls for owners, miners, deployers, oracle admins, and COTI-side minting.
- [ ] Keep clone deployment and initialization atomic, or add access-controlled initializers.
- [ ] Implement or remove `fetchBlockInterval`.
- [ ] Update stale NatSpec and privacy documentation.
