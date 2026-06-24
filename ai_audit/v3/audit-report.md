# PoD MPC Framework — Security & Quality Audit (v3)

Generated: 2026-06-18
Branch: `pp_upgrade_core`
Auditor: AI-assisted static review

---

## 1. Introduction

The **PoD MPC framework** lets ordinary EVM chains (Sepolia, Avalanche Fuji, …) drive
privacy-preserving Multi-Party-Computation (MPC) execution on **COTI**. It is, at its core, a
**cross-chain request/response bus** (`Inbox`) plus a set of application contracts built on top of
it (a private ERC-20 `PodERC20`, a `PrivacyPortal` deposit/withdraw bridge, and a generic
`PodLib`/`MpcExecutor` math layer).

This report is a **static security and quality review** focused on:

- The cross-chain machinery (`Inbox*`, `MinerBase`, fee/oracle layer).
- The privacy bridge and private token (`PrivacyPortal*`, `PodERC20*`, `PodErc20CotiMother`).
- The MPC encoding/execution layer (`MpcAbiCodec`, `MpcExecutor`, `PodLib*`).
- **Exploitability of cross-chain dApps** built on the bus.

It builds on the prior `ai_audit/v2/audit-report.md`. Several v2 findings have since been **fixed**
on this branch; those are tracked in [§7](#7-status-of-prior-v2-findings). Where an issue is judged
**by-design**, the design justification is recorded inline.

### 1.1 Scope

In scope (production contracts under `contracts/`):

```
Inbox.sol, InboxBase.sol, InboxMiner.sol, InboxUser.sol, InboxUserCotiTestnet.sol,
IInbox.sol, IInboxMiner.sol, MinerBase.sol, PodNetworkConstants.sol,
fee/IInboxFeeManager.sol, fee/InboxFeeManager.sol, fee/PriceOracle.sol, fee/uniswap/UniswapPriceOracle.sol,
mpc/PodLib.sol, mpc/PodLibBase.sol, mpc/PodLib64.sol, mpc/PodLib128.sol, mpc/PodLib256.sol,
mpc/PodUser.sol, mpc/PodUserSepolia.sol, mpc/coti-side/IPodExecutorOps.sol, mpc/coti-side/MpcExecutor.sol,
mpccodec/MpcAbiCodec.sol,
privacy/IPrivacyPortal.sol, privacy/PrivacyPortal.sol, privacy/PrivacyPortalFactory.sol,
token/perc20/IPodERC20.sol, token/perc20/PodERC20.sol, token/perc20/PodErc20Mintable.sol,
token/perc20/PodErc20MintableInitializable.sol,
token/perc20/cotiside/IPodErc20CotiSide.sol, token/perc20/cotiside/PodErc20CotiMother.sol,
utils/IWrappedNative.sol
```

Out of scope (per instructions — examples, tests, mocks, harnesses):

```
contracts/examples/**, contracts/test/**, contracts/mocks/**,
contracts/mpc/coti-side/MpcExecutorCotiTest.sol, contracts/mpc/coti-side/MpcExecutorCotiProxyInbox.sol
```

The vendored `contracts/utils/mpc/MpcCore.sol` / `MpcInterface.sol` (COTI precompile bindings) are
treated as a **trusted dependency**; their internal correctness is COTI's responsibility and is not
re-audited here.

### 1.2 Methodology & references

Manual line-by-line review against:

- ConsenSys Smart Contract Best Practices and the SWC registry.
- CryptoFin Solidity auditing checklist (mapped in `ai_audit/v1`).
- 2026 cross-chain bridge threat models: trusted-relayer/validator compromise, finality &
  reorg handling, message replay & domain separation, fee griefing, and circuit breakers
  (Sherlock 2026, bridge security checklists; cf. Ronin $625M, Wormhole $320M, Nomad $190M).

No dynamic exploitation, fuzzing, or formal verification was performed.

---

## 2. System model & trust boundaries

```
   SOURCE CHAIN (Sepolia / Fuji)                         COTI
  ┌──────────────────────────────┐                ┌──────────────────────────────┐
  │ PodERC20 / PrivacyPortal /    │                │ PodErc20CotiMother /          │
  │ PodLib dApp                   │                │ MpcExecutor (MPC ledger)      │
  │        │ sendTwoWayMessage    │                │        ▲ onlyInbox calls       │
  │        ▼                      │   MINER (off-  │        │                       │
  │   Inbox (source)  ───emits───▶│   chain relay) │──────▶ Inbox (COTI)            │
  │   ◀── callback/error one-way ─│◀──batchProcess─│  batchProcessRequests          │
  └──────────────────────────────┘                └──────────────────────────────┘
```

Key trust facts that frame every finding below:

1. **The miner is a fully trusted, centralized relayer.** `batchProcessRequests` is `onlyMiner`
   and performs **no cryptographic verification** of source-chain events — it simply asserts the
   `(sourceContract, targetContract, methodCall, fees, …)` of each mined request. Destination
   contracts authorize purely on `inbox.inboxMsgSender()` / `onlyInbox`. A compromised or malicious
   miner can therefore **forge any message**: mint unlimited private tokens, drain a portal,
   spoof transfer callbacks, etc. This is the single largest risk in the system.
2. **Owners/admins are highly privileged** (inbox owner, miner set, price admin, factory deployers,
   COTI mother owner). Compromise of any is severe.
3. **Replay is prevented on the destination by state**, not by proofs: `incomingRequests[requestId]`
   one-shot guard + contiguous per-target nonce + source/target chain-id checks embedded in the id.
4. **Finality is assumed, not enforced** on-chain — the miner is expected to wait for source-chain
   finality before relaying.

These are intentional architectural choices for an MPC-relayed system, but they must be stated
explicitly and operationalized (see [§3 C-01](#c-01-centralized-trusted-miner-is-a-single-point-of-total-compromise)).

---

## 3. Findings

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| C-01 | Centralized trusted miner is a single point of total compromise | Critical (trust model) | By-design — needs hardening |
| H-01 | Fee/gas budgets derived from `tx.gasprice` enable miner-griefing & underfunding | High | Open (unanswered in v2) |
| H-02 | No on-chain finality/reorg guard → double-mint on source reorg | High | By-design (off-chain) — needs controls |
| M-01 | Per-address pending lock lets anyone DoS portal withdrawals & targeted deposits | Medium | Open (new) |
| M-02 | No circuit breaker on deposits or inbox processing | Medium | Open (new) |
| M-03 | Spot Uniswap V2 reserves drive fee conversion | Medium | Accepted by-design (v2) |
| M-04 | `retryFailedRequest` shares one `_currentContext` slot with no reentrancy guard | Medium | Open (new) |
| L-01 | `retryFailedRequest` executes empty calldata & masks encode errors on re-encode failure | Low | Open (new) |
| L-02 | `_checkWithdrawalsNotPaused` fails open if controller reverts | Low | Open (new) |
| L-03 | Unrestricted `receive()` accumulates ETH | Low | Partially addressed (v2) |
| L-04 | Oracle misconfiguration (zero price) DoSes all sends | Low | Open |
| I-01..I-07 | Informational | Info | — |

### Critical

#### C-01: Centralized trusted miner is a single point of total compromise

**Affected:** `InboxMiner.sol`, `MinerBase.sol`, and every destination contract that authorizes via
`onlyInbox` + `inboxMsgSender()` (`PodERC20`, `PodErc20CotiMother`, `MpcExecutor`, `PrivacyPortal`).

`batchProcessRequests` accepts an arbitrary `MinedRequest[]` from any registered miner and executes
the encoded calls. There is no signature, Merkle proof, or light-client verification tying a mined
request to a real source-chain event. The only constraints are structural (contiguous nonce, source
& target chain-id embedded in `requestId`, one-shot `incomingRequests` guard).

**Impact (total):** A compromised miner key (or a malicious owner who adds a miner via
`MinerBase.addMiner`) can forge messages whose `sourceContract` equals a legitimate pToken or portal
and thereby:
- call `PodErc20CotiMother.mintPublic`/`mint` to credit arbitrary private balances (no collateral),
- forge `transferCallback`/`onPTokenTransferred` to release portal collateral without a real burn,
- forge any `MpcExecutor`/`PodLib` callback.

This mirrors the largest historical bridge losses (Ronin $625M, Harmony $100M — relayer/validator
key compromise) and the Nomad $190M case (acceptance of unverified messages).

**Justification / status:** This is an accepted architectural choice (the framework is an MPC relay,
not a trustless light-client bridge; cf. v2 I-01 "admin and miner roles are highly trusted"). It is
recorded here at Critical severity because the *security of all user funds reduces to miner & owner
key security*, and that fact should drive deployment controls — not be left implicit.

**Recommendations (operational, since the code is by-design):**
- Run miners behind an **M-of-N multisig / threshold attestation**, not a single EOA. A 2-of-3 model
  is insufficient for material TVL.
- Put `MinerBase`/inbox ownership and `PrivacyPortalFactory`/`PodErc20CotiMother` ownership behind a
  **timelocked multisig**; forbid threshold/delay reduction in the same tx.
- Add **velocity/rate limits** on mint and portal release (per-token, per-window caps).
- Add a global **circuit breaker** (see M-02).
- Document the byzantine-miner and compromised-admin runbook.

### High

#### H-01: Fee & gas budgets are derived from `tx.gasprice`

**Affected:** `InboxFeeManager.validateAndPrepareTwoWayFees` / `validateAndPrepareOneWayFees`,
consumed by `InboxBase` and `InboxMiner._localRequestExecutionBudget`.

```124:128:contracts/fee/InboxFeeManager.sol
        uint256 gasPrice = tx.gasprice != 0 ? tx.gasprice : DEFAULT_GAS_PRICE;
        callerGasLocalUnits = callbackFeeLocalWei / gasPrice;
        uint256 remoteGasWei = totalFeeLocalWei - callbackFeeLocalWei;
        targetGasRemoteUnits = Math.mulDiv(remoteGasWei / gasPrice, priceOracle.getLocalTokenPriceUSD(),
            priceOracle.getRemoteTokenPriceUSD());
```

`msg.value` is converted into a **gas-unit budget** by dividing by the *caller's* `tx.gasprice`. That
budget (`Request.targetFee`) is later used directly as the `call{gas: ...}` cap on the remote chain,
where the **miner pays the real gas**.

**Impact:** The budget a sender receives is inversely proportional to the gas price *they* choose for
the source transaction. During low-base-fee windows (or on chains where the effective gas price can
be pushed near the floor), a sender obtains a disproportionately large remote-gas budget for little
native payment. An attacker can submit many cheap messages whose targets deliberately consume the
full inflated budget, forcing the miner to spend real remote gas — an **economic griefing / DoS on
the relayer**, and a systematic under-collection of fees relative to execution cost.

**Attack scenario:** On a low-base-fee block the attacker sends `sendOneWayMessage` with minimal
`msg.value`; `totalFeeLocalWei / tx.gasprice` still clears `expectedMinFee`, yielding a large
`targetFee`. The remote target (attacker-controlled) burns the entire budget. Repeated, this drains
miner funds while the attacker pays ~nothing.

**Recommendation:** Decouple the conversion from the caller's `tx.gasprice`. Use an owner-set
minimum/maximum protocol gas price, a bounded gas-price oracle, or wei-denominated accounting with
the miner reimbursed from a committed budget. Add tests comparing paid value vs. stored budget vs.
remote reimbursement under low/normal/high gas-price conditions. (This was raised as v2 H-01 and not
addressed in the recorded answers.)

#### H-02: No on-chain finality or reorg guard — source reorg can double-mint

**Affected:** `InboxMiner.batchProcessRequests`, `PrivacyPortal.deposit`.

The destination executes mined requests as soon as the miner submits them. Nothing on-chain requires
the source event to be finalized, and there is no mechanism to roll back a destination effect if the
source transaction is later re-orged out.

**Impact:** If the miner relays a `PrivacyPortal.deposit` (or any pToken mint) based on a source
event that is subsequently reverted by a reorg, the COTI ledger has minted private tokens with no
backing collateral (the deposit on source never finalized). The user/attacker can then withdraw
against another portal's collateral, or transfer the unbacked balance. "A bridge cannot be more
secure than the weakest chain it connects to."

**Justification / status:** By design, the miner is expected to wait for source-chain finality
before relaying. The risk is that this is an *off-chain operational policy with no on-chain
enforcement*.

**Recommendation:** Document and enforce chain-appropriate confirmation depths in the miner; gate
withdrawal *release* behind a minimum age relative to the corresponding mint; pause relaying during
known source-chain upgrades/forks (see M-02). Consider a per-token mint/release rate limit so a
single reorg cannot be amplified.

### Medium

#### M-01: Per-address pending lock enables withdrawal DoS and targeted deposit griefing

**Affected:** `PodERC20` (`_pendingTransferRequestIds`), `PrivacyPortal` withdrawal path.

`PodERC20` allows only **one in-flight transfer/burn per address**, and a transfer locks **both**
`from` and `to`:

```581:583:contracts/token/perc20/PodERC20.sol
        if (_pendingTransferRequestIds[from] != bytes32(0) || _pendingTransferRequestIds[to] != bytes32(0)) {
            revert TransferAlreadyPending(from, to, _pendingTransferRequestIds[from]);
        }
```

Every portal withdrawal moves pTokens **to the portal address** (`transferFromAndCallWithPermit(...,
to = address(this), ...)`), and the post-release burn moves them **from the portal address**. So the
portal address is effectively a global lock for that token.

**Impact (griefing DoS):**
- **Withdrawals:** anyone holding ≥1 wei of the pToken can transfer it *to the portal address*,
  locking `_pendingTransferRequestIds[portal]`. While pending (a full cross-chain round trip), **all
  withdrawals for that token revert** (`TransferAlreadyPending`). Sustained spam halts withdrawals
  cheaply. Withdrawals are additionally serialized one-at-a-time even without an attacker.
- **Deposits/receives:** an attacker can lock a *specific victim recipient* by sending them a dust
  transfer (or any pending transfer), causing the victim's `deposit`→`mint(to=victim)` and incoming
  transfers to revert until the attacker's request settles.

**Recommendation:** Don't use a single shared lock keyed by the portal address for portal flows.
Options: key withdrawal locking by `withdrawalId` rather than the portal recipient; allow multiple
concurrent in-flight transfers per address (track by request id set); or special-case the portal so
its inbound transfers don't block other withdrawals. At minimum, document that withdrawals are
serialized and griefable, and rate-limit/whitelist who may move pTokens to the portal.

#### M-02: No circuit breaker on deposits or inbox message processing

**Affected:** `InboxMiner.batchProcessRequests`, `PrivacyPortal.deposit`/`depositNative`,
`PrivacyPortalFactory`.

`PrivacyPortal` has a withdrawal pause (`pauseController` → `withdrawalsPaused()`), but there is **no
pause for deposits**, and **no pause/kill-switch on the inbox** message-processing path. 2026 bridge
guidance treats the absence of an emergency stop able to halt *both* deposits and withdrawals as a
critical operational gap (needed during active exploits, source-chain upgrades, or reorgs).

**Impact:** During an in-progress incident (e.g. suspected miner compromise per C-01, or a source
fork per H-02) there is no on-chain way to stop new deposits from locking collateral or to stop the
inbox from executing forged/replayed batches.

**Recommendation:** Add an owner/guardian-gated pause to `deposit`/`depositNative` (reuse the
existing `pauseController` pattern) and a guardian-gated pause on `batchProcessRequests` (and/or on
mint/release in `PodErc20CotiMother`). Rehearse activation.

#### M-03: Spot Uniswap V2 reserves drive fee conversion

**Affected:** `UniswapPriceOracle`, `PriceOracle`, `InboxFeeManager`.

`UniswapPriceOracle._spotPrice` reads instantaneous V2 reserves (`getReserves`) and stores the spot
ratio; `PriceOracle` also lets a `priceAdmin` set prices directly. These prices convert fee payments
into remote gas budgets.

**Impact:** Spot reserves are manipulable (esp. thin pools). An attacker can skew the cached ratio so
later messages are under/over-charged.

**Justification / status (accepted by-design, v2 M-03):** Per the team, this only affects *fees*;
under-paying fees is a minor user benefit, and over-charging benefits COTI rather than an attacker,
so it is kept as designed. Residual note: this argument holds **only while the price feed cannot
also affect anything besides fees** — keep it isolated to fee math. Prefer a TWAP / trusted feed and
non-zero/bounded-movement sanity checks if feasible.

#### M-04: Execution path uses a single `_currentContext` slot with no reentrancy guard

**Affected:** `InboxMiner._executeIncomingRequest`, `InboxMiner.retryFailedRequest`,
`InboxBase.respond/raise`.

Incoming execution sets a single shared `_currentContext`, calls the target with a gas budget, then
clears it. `retryFailedRequest` is **permissionless** and also writes/clears `_currentContext`.
Neither path has a reentrancy guard.

```115:132:contracts/InboxMiner.sol
        _currentContext = ExecutionContext({
            remoteChainId: sourceChainId,
            remoteContract: incomingRequest.originalSender,
            requestId: requestId
        });
        ...
        (success, returnData) = targetContract.call(callData);
        _currentContext = ExecutionContext({remoteChainId: 0, remoteContract: address(0), requestId: bytes32(0)});
```

**Impact:** While a target is executing inside `batchProcessRequests` (its `_currentContext` set), it
(or any contract it calls) can invoke the public `retryFailedRequest`, which overwrites
`_currentContext` and resets it to zero on return. The outer target's subsequent `inbox.respond()` /
`inbox.raise()` then reverts with "no active message", so a legitimate two-way response can be
silently dropped (the outer call still returns success, so no error is recorded either). Origin
spoofing is *not* possible (retry only re-runs an already-mined request), so impact is limited to
context corruption / griefing of two-way flows that call untrusted code before responding.

**Recommendation:** Add a `nonReentrant` guard to `batchProcessRequests` and `retryFailedRequest`, or
make `_currentContext` a stack/save-restore value so nested execution cannot clobber an outer frame.
Document that target contracts must call `respond`/`raise` before any untrusted external call.

### Low

#### L-01: `retryFailedRequest` runs empty calldata and masks encode errors on re-encode failure

**Affected:** `InboxMiner.retryFailedRequest`.

```122:139:contracts/InboxMiner.sol
        (bool encodedOk, bytes memory callData, bytes memory encodeErr) = _safeEncodeMethodCall(
            incomingRequest.methodCall
        );
        if (!encodedOk) {
            _recordEncodeError(requestId, encodeErr);
        }
        ...
        (success, returnData) = targetContract.call(callData);
        ...
        if (!success) { revert RetryFailedRequestExecutionFailed(returnData); }
        delete errors[requestId];
        emit RetryFailedRequestSuccess(requestId);
```

Unlike `_executeIncomingRequest` (which `return`s on encode failure), `retryFailedRequest` falls
through: when re-encoding fails it records an encode error, then calls the target with **empty
calldata** (`callData == ""`), hitting the target's `receive`/`fallback`. If that empty call happens
to succeed, the code then `delete errors[requestId]` and emits `RetryFailedRequestSuccess`,
**erasing the just-recorded encode error and reporting a bogus success** for a request that never
actually re-executed its intended method.

**Recommendation:** `return` (or `revert`) immediately when `!encodedOk`, mirroring
`_executeIncomingRequest`. Do not proceed to call the target with empty calldata.

#### L-02: `_checkWithdrawalsNotPaused` fails open if the controller reverts

**Affected:** `PrivacyPortal._checkWithdrawalsNotPaused`.

```334:339:contracts/privacy/PrivacyPortal.sol
        (bool success, bytes memory data) = pauseController.staticcall(
            abi.encodeCall(IPrivacyPortalPauseController.withdrawalsPaused, ())
        );
        if (success && data.length >= 32 && abi.decode(data, (bool))) {
            revert WithdrawalsPaused();
        }
```

If the configured `pauseController` reverts, returns short data, or doesn't implement the function,
the check treats withdrawals as **not paused** (fail-open). A misconfigured/broken controller
silently disables the pause.

**Recommendation:** Fail closed (revert withdrawals if the controller call is unsuccessful), or
require the controller to be address(0) to disable rather than tolerating call failures.

#### L-03: Unrestricted `receive()` accumulates ETH

**Affected:** `PrivacyPortal`, `PodERC20`, `PodLibBase`.

These accept arbitrary native funds. `PrivacyPortal` now has `sweepNative` (good), but `PodERC20` /
`PodLibBase` have no sweep and can silently accumulate dust that later subsidizes operations off the
books. Low risk; flagged for accounting clarity (cf. v2 L-06, partially addressed).

**Recommendation:** Add owner sweep functions where balance is used for fees, and document the
funding model.

#### L-04: Oracle misconfiguration DoSes all sends

**Affected:** `InboxFeeManager` + `PriceOracle`.

If `priceOracle` is unset or `remoteTokenPriceUSD == 0`, `Math.mulDiv(..., localPrice, remotePrice)`
divides by zero and every `sendTwoWayMessage`/`sendOneWayMessage` reverts. Operational, not
exploitable, but a single bad admin write halts the whole bus.

**Recommendation:** Validate non-zero prices on set, and guard fee math with a clear revert
("oracle not configured") instead of an arithmetic panic.

### Informational

- **I-01 — Encrypted-input ciphertext binding.** `itUint*` inputs are validated via
  `MpcCore.validateCiphertext` inside `MpcAbiCodec.reEncodeWithGt`, executed from the **inbox**
  (self-call). The COTI precompile therefore binds the input to the inbox context rather than the
  end user, and the ciphertext travels publicly through mined events. Amounts are values, not
  payer-authenticated secrets, so reuse only reuses an amount; confirm with COTI that no
  cross-app/cross-user privilege derives from ciphertext reuse.
- **I-02 — `MpcAbiCodec.reEncodeWithGt` is hand-rolled ABI assembly.** It manually rebuilds head/tail
  ABI layout with inline assembly and attacker-influenced `datatypes`/`datalens`. It is wrapped in
  `try/catch` (encode failure → recorded error), limiting blast radius, but the complexity warrants
  dedicated differential fuzzing against `abi.encode`.
- **I-03 — Random executor methods return plaintext** (`rand*` → `abi.encode(uint256)`). Public
  randomness only; do not use as a hidden seed. (v2 I-02, by-design.)
- **I-04 — Public-amount paths reveal amounts** in calldata/events (`transferPublic`, `mintPublic`,
  `deposit`, withdrawal). By design; route privacy-sensitive flows through `itUint256` APIs. (v2 I-03.)
- **I-05 — Unbounded arrays.** `syncBalances(accounts[])` and `batchProcessRequests(mined[])` loop
  over caller-sized arrays and can hit block gas limits; `PrivacyPortalFactory` mappings are fine but
  any enumerable token list should be event-indexed.
- **I-06 — `Inbox.init` front-running** is mitigated because deployment uses CreateX
  `deployCreate3AndInit` (atomic init). Safe only as long as every deployment path keeps clone/init
  atomic (same applies to `PrivacyPortal.initialize`, `PodErc20MintableInitializable.initialize`).
  (v2 M-08, by-design.)
- **I-07 — `respond`/`raise` now bind to the target.** `require(msg.sender ==
  incomingRequest.targetContract)` is present (v2 M-01 fixed). The one-shot `inboxResponses` guard
  prevents double-replies.

---

## 4. Cross-chain exploit analysis (dApp builders)

This section answers the explicit request to scrutinize x-chain dApp exploitability.

| Vector | Result |
|--------|--------|
| **Message replay (historical)** | **Mitigated.** `incomingRequests[requestId]` one-shot guard rejects re-processing; per-target contiguous nonce enforced. |
| **Cross-route / cross-chain replay** | **Mitigated.** `requestId` embeds `sourceChainId`+`targetChainId`; `batchProcessRequests` reverts on `RequestSourceChainMismatch` / `RequestTargetChainMismatch` (v2 M-02 fixed). |
| **Forged messages** | **Trusted-miner dependent (C-01).** No proof verification; a malicious miner forges anything. |
| **Token-namespace impersonation on COTI** | **Mitigated by construction.** `PodErc20CotiMother` namespaces balances by `(sourceChainId, sourcePToken=inboxMsgSender.remoteContract)`; an attacker contract gets a different `tokenId` and cannot touch a real token's balances. Registration is gated to allowlisted factories. |
| **Unauthorized mint into a real token** | **Mitigated for honest miner.** PoD-side `mint` is gated by `_checkMinter` (portal is the sole minter for clones); COTI `mint` requires a registered pToken message. A malicious miner bypasses this (C-01). |
| **Callback spoofing to wrong recipient** | **Trusted-miner dependent.** `transferCallback` trusts the COTI-returned `to`; honest path is safe (peer check on `cotiChainId`/`cotiSideContract`). |
| **Stranded deposit on async mint failure** | **Practically safe / by-design.** `_mintInternal` only fails for `to==0` (excluded by `deposit`); gas-related failures are retryable via `retryFailedRequest` on the COTI inbox (v2 H-03 answer). Residual: a *permanent* mint failure leaves collateral with no portal-side refund. |
| **Stranded withdrawal on callback failure** | **Mitigated.** `PrivacyPortal.triggerWithdrawalRelease` is a permissionless retry that releases any withdrawal whose pToken transfer reached `Success` (v2 H-02 addressed); release now follows CEI (v2 L-01 fixed). |
| **Withdrawal DoS / serialization** | **Open (M-01).** |
| **Finality / reorg double-mint** | **Off-chain only (H-02).** |
| **Fee griefing** | **Open (H-01).** |
| **Reentrancy on portal release** | **Mitigated.** `nonReentrant` + CEI; native unwrap path also guarded. |

---

## 5. Security checklist

| Item | Status | Notes |
|---|---|---|
| Reentrancy | ⚠️ | Portal release is CEI + `nonReentrant`. Inbox execution path lacks a guard (M-04); `transferCallback` external call is post-state-update. |
| Access control | ⚠️ | `onlyInbox`/`onlyMiner`/`onlyOwner`/peer checks present and `respond` now binds to target. Residual: heavy admin/miner trust (C-01). |
| Arithmetic | ✅ | 0.8 checked math; MPC checked vs `mulWrapping*` separated and documented (v2 M-06 fixed). |
| External calls & interactions | ⚠️ | Cross-chain calls, arbitrary target calls, oracle reads, pToken callbacks are core boundaries; uncapped retry gas is by-design. |
| Denial of Service | ❌ | Withdrawal serialization/lock griefing (M-01); fee underpricing (H-01); unbounded arrays (I-05); no circuit breaker (M-02). |
| Front-running / MEV | ⚠️ | Public amount flows observable; spot oracle skew (M-03); ERC-20-style approve race noted in NatSpec. |
| Oracle manipulation | ⚠️ | Spot V2 reserves + manual admin prices (M-03); zero-price DoS (L-04). |
| Upgradeability / storage | N/A | No proxy upgrades; minimal clones with atomic init (I-06). |
| Auth (`msg.sender` vs `tx.origin`) | ✅ | No `tx.origin` auth. |
| Signature replay / permit | ✅ | Public transfer permit binds owner/spender/to/value/nonce/deadline/chainId/contract; per-owner nonce; dynamic domain separator. ERC-1271 not supported. |
| Initialization | ✅/⚠️ | Atomic clone+init via factory/CreateX; permissionless initializers safe only while atomic (I-06). |
| Event logging | ⚠️ | Rich events, but several failure modes (`RequestCallbackFailed`, `BurnDebtRecorded`, failed requests) rely on off-chain monitoring. |
| Input validation | ⚠️ | Zero-address/amount checks present; `_checkWithdrawalsNotPaused` fails open (L-02); `retryFailedRequest` empty-calldata path (L-01). |
| Gas griefing / block limits | ❌ | H-01, I-05, M-04. |
| Centralization / admin abuse | ❌ | C-01 dominates; needs multisig/timelock/rate-limits. |
| Replay / domain separation (x-chain) | ✅ | State-tracked one-shot ids with source+target chain binding. |
| Finality / reorg | ⚠️ | Off-chain only (H-02). |
| Circuit breaker | ❌ | Withdrawals pausable; deposits & inbox processing are not (M-02). |

Legend: ✅ Safe · ⚠️ Review/partial · ❌ Vulnerable/missing · N/A.

---

## 6. Recommended fix checklist

- [ ] (C-01) Multisig/threshold miners; timelocked multisig ownership; per-token mint/release rate limits; document byzantine-miner runbook.
- [ ] (H-01) Replace `tx.gasprice`-based budget conversion with a bounded/committed gas-price model; add fee-vs-budget-vs-reimbursement tests.
- [ ] (H-02) Enforce/document chain-appropriate finality in the miner; pause relaying during source upgrades/forks; rate-limit mints.
- [ ] (M-01) Stop using the portal address as a global pending lock; key withdrawal locking by `withdrawalId` or allow concurrent in-flight transfers.
- [ ] (M-02) Add guardian-gated pause to deposits and to inbox processing / COTI mint+release.
- [ ] (M-03) Prefer TWAP/trusted feed + non-zero/bounded-movement checks; keep price impact isolated to fee math.
- [ ] (M-04) Add `nonReentrant` to `batchProcessRequests`/`retryFailedRequest` or make `_currentContext` save/restore.
- [ ] (L-01) `return`/revert on `!encodedOk` in `retryFailedRequest`; never call the target with empty calldata.
- [ ] (L-02) Make `_checkWithdrawalsNotPaused` fail closed.
- [ ] (L-03) Add owner sweep to `PodERC20`/`PodLibBase`; document funding model.
- [ ] (L-04) Validate non-zero oracle prices; clear revert when oracle unconfigured.
- [ ] (I-02) Differential-fuzz `MpcAbiCodec.reEncodeWithGt` vs `abi.encode`.
- [ ] (I-05) Bound or paginate caller-sized arrays; rely on event indexing for enumeration.

---

## 7. Status of prior v2 findings

| v2 ID | Topic | This review |
|-------|-------|-------------|
| H-01 | `tx.gasprice` fee budgets | **Still open** → re-raised as H-01. |
| H-02 | pToken transfer-callback strands withdrawals | **Fixed** via `triggerWithdrawalRelease` + CEI. |
| H-03 | Async mint failure strands deposits | **Mitigated by-design** (inbox retry; mother mint can't fail for valid input). Residual noted in §4. |
| M-01 | `respond`/`raise` not bound to target | **Fixed** (`msg.sender == targetContract`). |
| M-02 | Mined id not checked vs source chain | **Fixed** (source + target chain-id guards). |
| M-03 | Spot Uniswap pricing | **Accepted by-design** → M-03. |
| M-04 | Fee estimator mixes units | **Fixed** (removed; only `calculateTwoWayFeeRequiredInLocalToken` kept). |
| M-05 | Uncapped retry gas | **By-design** (caller pays). |
| M-06 | Wrapping MPC multiply | **Fixed** (`mul*` checked vs `mulWrapping*`). |
| M-07 | `ownerMint` desync | **Fixed** (mother `ownerMint` reverts `OwnerMintNotSupported`). |
| M-08 | Permissionless clone initializers | **By-design** (factory/CreateX atomic) → I-06. |
| L-01 | CEI in `onPTokenTransferred` | **Fixed** (status set before transfer). |
| L-02 | `hardhat/console.sol` in prod | **Fixed** (no console imports remain). |
| L-03 | Send couples to oracle refresh | **By-design** (auto-sync). |
| L-04 | `fetchBlockInterval` unused | **Fixed** (now time-based `fetchInterval`). |
| L-05 | Immutable `pauseController` | **Fixed** (`setPauseController`). |
| L-06 | Unrestricted `receive` | **Partially** (portal `sweepNative` added) → L-03. |
| L-07 | Unbounded factory array | **Addressed** (mapping-based factory) → I-05 generalized. |

---

## 8. Conclusion

On this branch the framework has **closed most v2 issues** (target-bound replies, chain-id checks,
checked/wrapping MPC split, withdrawal retry + CEI, console removal, oracle interval). No memory-safety
or fund-draining bug was found in the *honest-miner* model.

The residual risk is dominated by **trust and economics rather than code bugs**:

1. The system's safety reduces to **miner & admin key security** (C-01) — this must be hardened
   operationally (multisig, timelock, rate limits, circuit breaker).
2. **Fee/gas accounting via `tx.gasprice`** (H-01) and the **absence of on-chain finality enforcement**
   (H-02) are the two open design weaknesses most likely to be exploited for griefing or reorg
   double-mint.
3. A concrete, code-level **withdrawal DoS** (M-01) and the **missing deposit/inbox circuit breaker**
   (M-02) should be fixed before mainnet TVL grows.

This static review does not replace a professional audit, formal verification, or economic modeling,
and explicitly cannot assess off-chain miner key management — which, per C-01, is where the bulk of
the real-world risk lives.
