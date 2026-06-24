# AI-assisted audit — v3

Full security & quality review of the **PoD MPC framework** production contracts under
`contracts/` (examples, tests, mocks, and COTI test/proxy harnesses excluded per request).

- **Report:** [`audit-report.md`](./audit-report.md)
- **Focus:** cross-chain interactions and exploitability of x-chain dApps built on the `Inbox`.
- **Baseline:** builds on `ai_audit/v2`; §7 of the report tracks which v2 findings are now fixed,
  by-design, or still open.

## Methodology

Manual review against ConsenSys Smart Contract Best Practices, the SWC registry, the CryptoFin
checklist (see `ai_audit/v1`), and 2026 cross-chain bridge threat models (trusted-relayer/validator
compromise, finality & reorg handling, message replay & domain separation, fee griefing, circuit
breakers).

Findings carry a severity (Critical / High / Medium / Low / Informational). Issues that are
intentional design choices include the design justification inline.

## Scope limits

Static review only — no dynamic exploitation, fuzzing, formal verification, or economic modeling.
The vendored `contracts/utils/mpc/MpcCore.sol` (COTI precompile bindings) and **off-chain miner key
management** are trusted dependencies and are not assessed here; per finding C-01 that is where most
real-world risk resides.
