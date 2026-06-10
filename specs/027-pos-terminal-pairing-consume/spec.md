# Feature Specification: POS Terminal-Pairing CONSUME (`posPairTerminal`)

**Feature Branch (speckit nominal)**: `027-pos-terminal-pairing-consume`
(implemented on `feat/pairing-consume` per the orchestrator dispatch
Q-DP2-PAIRING-CONSUME; the speckit branch-switch was intentionally NOT taken so
the dispatch branch is preserved.)

**Created**: 2026-06-10

**Status**: Draft → implemented in this slice

**Input**: Orchestrator dispatch `Q-DP2-PAIRING-CONSUME` — implement the server
side of `posPairTerminal` to the binding contract
`packages/contracts/openapi/pos-terminal-pairing.openapi.yaml` (CONSUME only;
issuance OUT OF SCOPE).

> **Arc context (grounding, not a clarification).** This is the missing server
> side of POS terminal pairing — the verified blocker for an in-app POS live
> smoke. The contract fully specifies the CONSUME operation (`posPairTerminal`),
> so this is *implement-to-spec*. The ISSUANCE side (an admin mints a
> `pairing_code`) has **no contract** and is a separate downstream workstream; a
> `pairing_codes` row is **seeded directly** for the smoke through the same
> authorized seed lane as the pilot tenant/operator. This slice authors NO
> issuance endpoint and edits NO contract.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — A POS terminal redeems a one-time pairing code (Priority: P1) MVP

A freshly-installed POS terminal has no `device_token`. An operator types the
short-lived `pairing_code` an admin issued out-of-band. The terminal POSTs
`{ pairing_code }` to `POST /api/pos/v1/terminals/pair` (unauthenticated — it has
no token yet). On success the backend burns the code (`pending → used`), creates
the device's server-side trust (`devices` row, hashed token) + its terminal
record, and returns the long-lived `device_token` ONCE plus the full
tenant/branch/printer binding. The terminal stores the token in OS secret storage
and reads the binding fields for its receipt + print pipeline.

**Acceptance**: a seeded `pending` code → 200 with a `device_token` that
authenticates against `PosDeviceAuthGuard` (the read-down catalogue routes accept
it); replay of the same code → 410 `EXPIRED_CODE`.

### User Story 2 — Bad / spent / mismatched codes fail in a closed, non-disclosing set (P1)

- Unknown code → 404 `INVALID_CODE` (non-disclosing per §XIV — no cross-tenant
  signal).
- `used` / `cancelled` / past-`expires_at` code → 410 `EXPIRED_CODE`.
- The code's terminal is already paired under the SAME branch → 409
  `ALREADY_PAIRED` (NOT a fresh token).
- Already paired under a DIFFERENT branch → 409 `BRANCH_MISMATCH` (MUST NOT clear
  or replace the prior pairing — recovery is admin-driven, FR-14).
- Malformed body (missing/short/long `pairing_code`) → 400 `validation_failure`.
- Too many attempts for a code or source IP → 429 `RATE_LIMITED` + `Retry-After`.

### Edge cases
- Two terminals racing the same code: the `pending → used` transition is a guarded
  conditional UPDATE inside one tx; the loser sees 0 rows updated → 410.
- The code's `device_token` MUST NEVER be logged, echoed to another endpoint, or
  appear in an audit payload. The `pairing_code` is likewise never logged and is
  stored hashed.

## Requirements *(mandatory)*

- **FR-001** Implement EXACTLY operationId `posPairTerminal` at the canonical path
  `POST /api/pos/v1/terminals/pair`. Request `TerminalPairRequest`
  (`pairing_code` only, 6–32 chars). Success `TerminalPairResponse` (all 11
  required fields).
- **FR-002** `security: []` — the ONLY unauthenticated POS operation. No clerkJwt,
  no device bearer. Implemented by registering NO auth guard on this controller
  (DP-2 applies guards per-controller; there is no global `APP_GUARD`), so no
  other guard is weakened.
- **FR-003** Closed error set with exact statuses: `INVALID_CODE`(404),
  `EXPIRED_CODE`(410), `ALREADY_PAIRED`(409), `BRANCH_MISMATCH`(409),
  `RATE_LIMITED`(429 + `Retry-After`), `validation_failure`(400).
- **FR-004** State transition `pending → used` on success; replay → 410.
- **FR-005** The issued `device_token` MUST be a credential `PosDeviceAuthGuard`
  accepts: insert a `devices` row with `token_hash = hashToken(rawToken)`,
  `tenant_id`, `store_id`; return the raw token once. Reuse `packages/auth`
  (`generateRawToken`/`hashToken`); do not invent a token scheme.
- **FR-006** The `pairing_code` is stored HASHED (`hashToken(code)`), never
  plaintext. `device_token` + `pairing_code` are NEVER logged / audited / echoed.
- **FR-007** All writes run in ONE transaction under the code's tenant GUC
  (`runWithTenantContext`); RLS scopes the rows.
- **FR-008** Per-`pairing_code` attempt accounting drives 429 (see data-model);
  edge-proxy IP limiting is documented as the complementary layer (FR-9 of the
  contract narrative).

## Out of scope
- Issuance / admin code-minting endpoint and its contract.
- Console pairing-admin UI.
- The POS-Pulse client one-liner (`network.ts:55` path fix) — separate repo.
- Any second migration; any edit to any OpenAPI spec.
