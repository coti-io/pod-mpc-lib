# Inbox Gas Efficiency Audit

Generated: 2026-06-24  
Scope: `InboxBase`, `InboxMiner`, `InboxFeeManager`, `MpcAbiCodec`, Inbox tests/scripts

## Summary

The Inbox system's gas cost is dominated by three categories:

1. Full `Request` storage writes that include dynamic `MpcMethodCall` payloads.
2. Full method-call payload logging in `MessageSent` and `MessageReceived`.
3. Inbound execution overhead: encoding/validation plus the target subcall stipend.

The first implementation pass keeps public semantics and event shapes unchanged. It focuses on low-risk savings:

- Raw mined calls now bypass the external self-call try/catch encoder.
- Oracle prices are fetched through one `getPricesUSD()` call instead of two calls.
- Fee configs are cached in memory during validation and fee estimation.
- `respond` / `raise` cache `_currentContext` instead of re-reading it.
- `getRequests` avoids `from + len` overflow, caches `chainId`, and uses unchecked loop increments.
- `batchProcessRequests` removes a redundant storage-ref reload and uses unchecked loop increments.

## Baseline Matrix

Repeatable benchmark script:

```bash
npm run test:inbox-gas
```

The benchmark logs a JSON object prefixed with `[inbox-gas]` and covers:

| Metric | Path |
| --- | --- |
| `sendOneWay.raw.2bytes` | `sendOneWayMessage` with raw calldata |
| `sendTwoWay.raw.2bytes` | `sendTwoWayMessage` with callback fee |
| `batchProcessRequests.raw.success` | mined raw calldata target call |
| `batchProcessRequests.raw.respond` | mined target call that calls `inbox.respond` |
| `batchProcessRequests.raw.failure` | mined target call that records execution failure |
| `retryFailedRequest.raw.success` | retry of a previously failed raw request |
| `estimate.getRequests.2` | read-side estimate for two full request structs |

The matrix intentionally uses raw calldata (`selector == 0`) to isolate Inbox overhead before adding MPC codec costs.

## Ranked Findings

### G-01: Full `MpcMethodCall` logs are expensive

Affected:

- `InboxBase.MessageSent`
- `InboxBase.MessageReceived`

Both events include the full `MpcMethodCall`, which duplicates data already stored in request state. This is likely the largest optional Inbox overhead for large payloads.

Risk: high compatibility impact. Relayers and off-chain tooling may depend on full event payloads.

Recommendation: decide separately whether to add compact events (`methodCallHash`, lengths, selectors) while keeping the existing events for compatibility, or to replace full-payload events in a breaking release.

### G-02: Full dynamic `Request` storage dominates send and mine paths

Affected:

- `requests[requestId] = request`
- `incomingRequests[requestId] = newIncomingRequest`

`Request` stores `MpcMethodCall`, including `bytes`, `bytes8[]`, and `bytes32[]`. This is necessary for retry, response linking, and read APIs, but is expensive.

Risk: medium to high if compacted, because retry and indexers need the payload.

Recommendation: add compact request summary getters first. Consider splitting metadata and payload storage only after measuring which consumers require full `Request` reads.

### G-03: Raw mined calls paid MPC encoder try/catch overhead

Affected:

- `InboxBase._safeEncodeMethodCall`

Raw calls (`selector == 0`) do not need MPC re-encoding, but previously still entered the external self-call try/catch path. This pass adds a raw-call fast path while preserving non-reverting error recording for invalid raw metadata.

Risk: low.

Status: optimized.

### G-04: Oracle price reads used two external calls

Affected:

- `InboxFeeManager._validatedOraclePrices`

The oracle already exposes `getPricesUSD()`. This pass uses that combined getter.

Risk: low.

Status: optimized.

### G-05: Hot paths re-read storage values

Affected:

- `respond`
- `raise`
- fee config validation
- `getRequests`
- `batchProcessRequests`

This pass caches active context, fee configs, and chain id where straightforward.

Risk: low.

Status: optimized.

### G-06: View pagination can be expensive

Affected:

- `getRequests(targetChainId, from, len)`

The function returns full nested `Request[]`. Large `len` can exceed RPC gas even though it is view-only.

Risk: medium if capped, because callers may rely on arbitrary page sizes.

Recommendation: add a lightweight summary getter and document recommended page sizes. A hard cap should be a conscious API decision.

## Event Compression Tradeoffs

Event compression is the biggest likely gas win, but it changes off-chain behavior. The current events allow a relayer or indexer to reconstruct request payloads from logs alone. A compact design would require reading request storage or using a separate payload availability channel.

Options:

| Option | Gas Impact | Compatibility |
| --- | --- | --- |
| Keep full events | None | Fully compatible |
| Add compact events alongside full events | More gas, better migration | Compatible, not an optimization yet |
| Replace full events with compact events | Largest savings | Breaking for log-only relayers/indexers |
| Emit full payload only for debug/test deployments | Large production savings | Requires deployment-mode policy |

Recommendation: keep full events for now. If production payloads are large enough to justify compression, introduce a migration period with both full and compact events plus relayer updates.

## Follow-Up Candidates

- Add gas snapshots to CI if the test runner can support stable Hardhat gas reporting.
- Add a lightweight `getRequestSummaries(targetChainId, from, len)` view.
- Benchmark MPC-encoded requests separately from raw calldata requests.
- Review `MpcAbiCodec._slice` and copy loops after baseline MPC measurements; optimizing them without data risks adding complexity in the wrong place.
