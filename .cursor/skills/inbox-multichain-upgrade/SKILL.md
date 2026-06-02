---
name: inbox-multichain-upgrade
description: Upgrade any app, miner/relayer, indexer, or test that uses the cross-chain Inbox to the per-target request-isolation model (requestId now encodes source+target+nonce). Use when an inbox-consuming component must support more than two chains, when getRequests/getRequestsLen/getRequestId/unpackRequestId stop compiling, when mined batches revert with "nonces must be contiguous" or "target chain mismatch", or when migrating to inbox request ids that carry both chain ids.
---

# Inbox Multi-Chain Request Upgrade

## When To Use

Use this skill to migrate any component that talks to the `Inbox` (`InboxBase` / `InboxMiner`) when moving from the legacy single-global-nonce model to **per-target request isolation**. Apply it to:

- Solidity apps that read inbox request views (`getRequests`, `getRequestsLen`, `getRequestId`, `unpackRequestId`).
- Off-chain miners / relayers that copy requests from a source chain to a target chain.
- Indexers, dashboards, or frontends that track requests by `requestId`.
- Tests/fixtures that call the inbox request APIs.

If a component only **sends** messages (`sendOneWayMessage` / `sendTwoWayMessage`) and **receives** callbacks/errors, it is largely unaffected — skip to [Apps that only send/receive](#apps-that-only-sendreceive).

## What Changed And Why

**Problem (legacy):** the inbox used one global outbound nonce, so `requestId = pack(chainId, globalNonce)` was a single interleaved sequence across every target. When a source chain sent to multiple targets, each target received a *subset* with gaps in the nonce sequence, and the miner's contiguity guard (`minedNonce == allowedNonce`) reverted. This only worked with exactly two chains.

**Fix:** isolate request bookkeeping per chain.

1. **Outbound nonce is per target chain** — the sequence each target receives is contiguous `1,2,3,…` again, so the contiguity guard keeps working unchanged.
2. **`requestId` now packs both chain ids and the nonce**, making ids globally unique and self-describing (you can recover both routing chains from any id).
3. **Storage stays single-key** (`requests[requestId]`, `incomingRequests[requestId]`) because the richer id removes all collisions, so requests are retrievable **by id alone**.

## requestId Layout (256 bits)

```
[ sourceChainId : 64 bits ][ targetChainId : 64 bits ][ nonce : 128 bits ]
   bits 255..192               bits 191..128             bits 127..0
```

- Chain ids must fit in **64 bits** (all real EVM chain ids do).
- `nonce` is the **per-target** nonce (low 128 bits), so legacy "nonce = low 128 bits" extraction still works.

### Solidity reference

```solidity
function _packRequestId(uint256 sourceChainId, uint256 targetChainId, uint256 nonce)
    internal pure returns (bytes32)
{
    require(sourceChainId <= type(uint64).max, "Inbox: sourceChainId too large");
    require(targetChainId <= type(uint64).max, "Inbox: targetChainId too large");
    require(nonce <= type(uint128).max, "Inbox: nonce too large");
    return bytes32(
        (uint256(uint64(sourceChainId)) << 192) |
        (uint256(uint64(targetChainId)) << 128) |
        uint256(uint128(nonce))
    );
}

function _unpackRequestId(bytes32 id)
    internal pure returns (uint256 sourceChainId, uint256 targetChainId, uint256 nonce)
{
    uint256 p = uint256(id);
    sourceChainId = uint256(uint64(p >> 192));
    targetChainId = uint256(uint64(p >> 128));
    nonce         = uint256(uint128(p));
}
```

### TypeScript reference

```ts
export const packRequestId = (sourceChainId: bigint, targetChainId: bigint, nonce: bigint): `0x${string}` => {
  const v =
    ((sourceChainId & ((1n << 64n) - 1n)) << 192n) |
    ((targetChainId & ((1n << 64n) - 1n)) << 128n) |
    (nonce & ((1n << 128n) - 1n));
  return `0x${v.toString(16).padStart(64, "0")}`;
};

export const unpackRequestId = (id: `0x${string}`) => {
  const p = BigInt(id);
  return {
    sourceChainId: (p >> 192n) & ((1n << 64n) - 1n),
    targetChainId: (p >> 128n) & ((1n << 64n) - 1n),
    nonce: p & ((1n << 128n) - 1n),
  };
};
```

## API Changes (old → new)

| Surface | Before | After |
| --- | --- | --- |
| `getRequests` | `getRequests(from, len)` | `getRequests(targetChainId, from, len)` |
| `getRequestsLen` | `getRequestsLen()` | `getRequestsLen(targetChainId)` |
| `getRequestId` (pure) | `getRequestId(chainId, nonce)` | `getRequestId(sourceChainId, targetChainId, nonce)` |
| `unpackRequestId` (pure) | returns `(chainId, nonce)` | returns `(sourceChainId, targetChainId, nonce)` |
| get one outbound by id | read `requests(id)` mapping | `getRequest(id)` **(new)** or `requests(id)` |
| get one incoming by id | read `incomingRequests(id)` mapping | `getIncomingRequest(id)` **(new)** or `incomingRequests(id)` |

**Unchanged:** `requests(bytes32)`, `incomingRequests(bytes32)`, `lastIncomingRequestId(uint256 sourceChainId)`, `batchProcessRequests(uint256 sourceChainId, MinedRequest[])`, the `MinedRequest` struct, the `Request` struct, and all events.

**New on-chain guard:** `batchProcessRequests` now also requires each mined id's `targetChainId == this chain` (reverts `"Inbox: requestId target chain mismatch"`), in addition to the existing source-chain and contiguity checks.

## Migration By Consumer Type

### Off-chain miner / relayer

This is the component most affected. The miner copies requests destined for **its own chain** from a source inbox.

1. When reading the source inbox, scope by the miner's own chain id:
   - `getRequestsLen(myChainId)` instead of `getRequestsLen()`.
   - `getRequests(myChainId, from, len)` instead of `getRequests(from, len)`.
   The client-side `request.targetChainId === myChainId` filter is now redundant (the server scopes it), but harmless to keep.
2. `from` is now a **per-target** offset (cursor within that target's sequence), not a global index.
3. Nonce extraction is unchanged: `nonce = BigInt(requestId) & ((1n << 128n) - 1n)`.
4. Update your ABI: add `targetChainId` to `getRequests` / `getRequestsLen` inputs. `incomingRequests` and `lastIncomingRequestId` inputs are unchanged.
5. The on-chain target-chain guard means a misrouted batch now reverts deterministically — handle/skip rather than retry blindly.

```ts
const total = await source.read.getRequestsLen([BigInt(myChainId)]);
const reqs = await source.read.getRequests([BigInt(myChainId), 0n, total]);
// reqs are already only those targeting myChainId, in contiguous per-target nonce order.
await target.write.batchProcessRequests([BigInt(sourceChainId), reqs.map(toMinedRequest)]);
```

### Solidity apps that read request views directly

- Replace `getRequestsLen()` → `getRequestsLen(targetChainId)` and `getRequests(from, len)` → `getRequests(targetChainId, from, len)`.
- Replace 2-tuple `unpackRequestId` destructuring with the 3-tuple `(sourceChainId, targetChainId, nonce)`.
- Replace `getRequestId(chainId, nonce)` with `getRequestId(sourceChainId, targetChainId, nonce)`.
- To fetch a single request by id, prefer the new `getRequest(id)` / `getIncomingRequest(id)` views.

### Apps that only send/receive

Apps built on `PodLib` / `PodUser` (e.g. `MpcAdder`, `PodERC20`, `Millionaire`, privacy portal tokens) that call `sendOneWayMessage` / `sendTwoWayMessage` and implement callback/error selectors **need no logic changes**. The `requestId` they receive is still returned the same way and is still usable as an opaque handle — it is now just globally unique and carries both chain ids.

Audit only for direct calls to the changed views above, or assumptions that "`requestId` = source + nonce" (it is now source + target + nonce).

### Indexers / frontends / dashboards

- `requestId` is now globally unique across all `(source, target)` pairs — you can drop any per-target keying workarounds.
- You can derive **both** chains from an id (see `unpackRequestId` TS helper); previously only the source was recoverable.
- Events are unchanged (`MessageSent` still carries indexed `requestId` + `targetChainId`).

## Pitfalls & Gotchas

- **Chain ids must fit in 64 bits.** `_packRequestId` reverts otherwise. Real EVM chain ids are far below `2^64`.
- **`requestId` semantics changed.** Anything assuming the high 128 bits are the source chain id is wrong now — the source is the top 64 bits, the target is the next 64.
- **Per-target counts.** `getRequestsLen(target)` is the count *to that target*, not the total outbound count. There is no single global count anymore.
- **Storage layout changed.** This is a non-backward-compatible storage change to the inbox. Already-deployed inboxes must be **redeployed**. With deterministic CreateX deploys, bump the salt label (e.g. `pod.inbox.v1` → `pod.inbox.v2`) to mint a fresh address family, and update all stored inbox addresses/config.
- **ABIs.** Regenerate/patch any hand-written ABIs for `getRequests` / `getRequestsLen` (added `targetChainId`). `getRequest` / `getIncomingRequest` are new functions you may want to add.
- **Mixed-version chains.** All inboxes in a connected topology must run the new version; a new-version miner cannot correctly drive a legacy inbox and vice-versa.

## Migration Checklist

- [ ] Contracts: inbox compiled with per-target nonce + 3-field `requestId`.
- [ ] All `getRequestsLen()` / `getRequests(from,len)` call sites pass `targetChainId`.
- [ ] All `unpackRequestId` consumers handle the 3-tuple; all `getRequestId` calls pass `sourceChainId, targetChainId, nonce`.
- [ ] Miner/relayer scopes reads by its own chain id and tolerates the target-chain revert.
- [ ] Hand-written ABIs updated (`getRequests`, `getRequestsLen`; optionally add `getRequest`, `getIncomingRequest`).
- [ ] Inbox redeployed (salt bumped for deterministic deploys); all inbox addresses/config updated.
- [ ] Regression coverage: a source sends to ≥2 targets interleaved, and each target mines its own subset contiguously.
- [ ] Send-only / receive-only apps reviewed for direct view usage or `requestId = source+nonce` assumptions.
```
