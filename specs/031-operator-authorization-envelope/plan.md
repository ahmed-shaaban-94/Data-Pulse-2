# Implementation Plan — D1+D2 DP-2 Operator-Authorization Envelope (Mint, Return & Re-wire)

> **PLAN ONLY.** Authored after owner ratification of the carried Open Questions (spec.md Clarifications Session 2026-06-12). This is an architecture-only planning record; **no code, schema, migration, OpenAPI, or test is authored here.** Advancing past this plan (`/speckit.tasks`, implementation) requires a **further** explicit, scoped owner approval after G10 dispatch-clearance.

**For:** Data-Pulse-2 to execute **POST-dispatch** (after a further owner approval + verified G10 dispatch-clearance).  **Altitude:** architecture only.  **Date:** 2026-06-12.  **Decider:** Owner (Ahmed Shaaban).

**Gate tags for the whole slice:** **G10** (Identity & Access Boundary Gate — boundary signed; blocks all D1/D2 implementation until dispatch-clearance) · **G2** (Contract Gate — the new OQ-5 authorization-credential scheme + the sale-route security re-wire in `pos-sales/sales.yaml`) · **no G3** (Migration Gate — **OQ-1=1-A-i reuses the existing `auth_tokens` row with zero schema change**; the clean contrast with sibling 029, which carried G3 for its link table).

> Every phase below describes an approach the owning repo would take. This document defines no TypeScript, no SQL, no OpenAPI YAML — those are produced inside Data-Pulse-2 under its own review, only after dispatch. The phase order is the recommended approach, not an executed change.

---

## G10 verification (planning precondition)

| Check | Result (in-repo, `origin/main` this session) |
|---|---|
| The 028 boundary 031 consumes is **signed** | **Confirmed.** DP-2 028 spec records the umbrella `Retail-Tower-Orchestrator` 028 boundary merged (PR #85/#86), G10 wired; OQ-8 SIGNED. Siblings 029 (PR #550) + 030 (PR #551) already shipped against the same signed boundary. |
| The recommended-first D3 sequencing is satisfied | **Confirmed.** 029 (provider-neutral identity link) CLOSED 2026-06-12. D3 was recommended-first, not a hard gate on D1. |
| The authoritative G10 gate **record** | **Lives upstream in the Orchestrator** (`docs/gates/cross-repo-gates.md`), **not checked out in this repo.** What is verifiable here is the *planning precondition* (boundary signed) — established above. |

**Honest posture:** "boundary signed → planning precondition met." Gate **clearance for dispatch** is an Orchestrator-side check, which the owner's ratification correctly did **not** authorize. G10 is therefore tagged on every phase below as the standing **dispatch** gate, exactly mirroring sibling 029's posture (READY ≠ dispatch-authorization).

## Constitution Check

| Principle | Bearing on this slice | Status |
|---|---|---|
| **III. Backend Authority & Data Integrity** | DP-2 stays the authority: the envelope is server-minted only after the full sign-in predicate passes; the credential's authority is the server-side `auth_tokens` row, not anything the client asserts. Uniform non-disclosing 401 preserved. | ✅ Upheld |
| **IV. Contract-First POS Integration** | The OQ-5 scheme + sale-route re-wire is authored in `packages/contracts/openapi/pos-sales/sales.yaml` (G2); `operationId`s are **unchanged** (no breaking rename — only the `security` scheme changes); conformance tests gate it. Co-traveling DOC-3 rename is in-scope precisely to keep contract↔runtime consistent. | ✅ Upheld (G2) |
| **XII. Authorization & Object Safety** | The keystone principle here. The re-wired routes keep **object-level authorization** (the composed predicate: identity + device + tenant/store + eligibility + non-expiry); `tenant_id`/`store_id` are resolved from the token's server-side binding, **never** the body; **default-deny** is strengthened — retiring Option-Y removes a synthesized-principal path in favor of the canonical credential the guard already demands. No mass-assignment surface added. | ✅ Upheld / strengthened |
| **XIII. Auditability & Provenance** | `sale.captured/voided/refunded` retain a real `actor_user_id` + resolved `(tenant, store, user, device)` scope (G-5); the envelope material never enters logs/audit rows. | ✅ Upheld |
| **XIV. PII & Data Lifecycle** | No new PII surface; no new table or column (no G3). The envelope is an opaque credential, not personal data. | ✅ N/A — no new data class |

> No gate violations. The slice **reduces** authorization-surface risk (one canonical credential path replacing a synthesized-principal Option-Y path). No NEEDS CLARIFICATION remains after the 2026-06-12 ratification (the two deferred OQs are owner-confirmed "pending 028", planned around — not unresolved unknowns blocking the plan).

## Approach summary

D1+D2 is a **return + re-wire**, not a build-from-zero. The credential, its scope binding, TTL, and sign-out revocation **already exist** on `origin/main`; the verification path that accepts it (`AuthGuard` → `findActiveByRawToken` → a `{ kind:"token", scope:"pos_operator" }` principal) is **already wired**, and `pos_operator` is already in `BEARER_AUTH_SCOPES`. Two things are missing: (a) sign-in **returns** a client-presentable form of the credential (OQ-1=1-A-i: the raw `generateRawToken()` value currently discarded), and (b) the sale-write routes are **re-pointed** off the Option-Y `PosOperatorSaleAuthGuard` onto the canonical `pos_operator` path. The sequencing is **return-at-sign-in → re-wire-the-routes → retire-Option-Y → contract scheme rename**, each phase independently reviewable and each preserving the full composed authorization predicate (identity + device trust + tenant/store access + POS eligibility + non-expiry).

## Phase 0 — Pre-flight (gate + state) [G10]

- **[G10]** Confirm G10 dispatch-clearance is granted before any implementation begins (boundary signed = precondition met; clearance = the Orchestrator-side check). D1/D2 must not begin while G10 is open for dispatch.
- **[G0]** Confirm Data-Pulse-2 `origin/main` is the clean state read this session; re-read `apps/api/src/pos-operators/pos-operators.service.ts` (`issueOperatorSessionRow`, sign-out revoke), `apps/api/src/auth/auth.guard.ts` (`findActiveByRawToken`, `principalFromToken`, `BEARER_AUTH_SCOPES`), `apps/api/src/auth/pos-operator-auth.guard.ts` (canonical scope gate), `apps/api/src/auth/pos-operator-sale-auth.guard.ts` (Option-Y, to be retired on the sale routes), and `apps/api/src/catalog/sales/sales.controller.ts` (route↔guard wiring) before touching anything.
- Confirm no concurrent slice has moved the resolver (D3/029 changed only the identity→`user_id` hop; the operator/sale-sync credential path it explicitly left unchanged — N-2 of 029).

## Phase 1 — Return the envelope at sign-in (OQ-1 = 1-A-i) [G10]

- In `issueOperatorSessionRow`, **stop discarding** the raw value already produced by `generateRawToken()`; return it alongside the existing `{ id, issued_at }` so the sign-in (and takeover-confirm) response can carry a client-presentable **operator-authorization envelope**. The stored `token_hash` and the `auth_tokens` row are unchanged (no schema change → **no G3**).
- Extend the sign-in / takeover-confirm response DTO (`PosOperatorSessionSummaryBody` / `PosOperatorSignInResponseBody`) to include the envelope field, in addition to today's summary. *(The wire field name is a contract concern — see Phase 4 / G2.)*
- The envelope **is** the credential the canonical guard already accepts: no new verification primitive, no new revocation mechanism. TTL = the existing 8h `OPERATOR_SESSION_TTL_MS` (OQ-2). Refresh = **none** (OQ-3 deferred fallback) — the envelope is not refreshable in v1.
- Preserve the non-disclosing failure posture: every sign-in refusal still collapses to the same generic 401; the raw envelope never appears in any log line or audit row (existing FR-POS-AUTH-10 discipline).

## Phase 2 — Re-wire capture/void/refund onto the canonical path [G10]

- Re-point `captureSale` (`POST /api/pos/v1/sales`), `recordVoid` (`.../void`), and `recordRefund` (`.../refund`) from `@UseGuards(PosOperatorSaleAuthGuard)` (Option-Y) onto the **canonical `pos_operator` authorization path** — the same `PosOperatorAuthGuard` already on `readSale` (`GET .../:saleRef`), which the returned envelope now satisfies (closes the phantom, D2).
- A device-only or provider-JWT-only request must still be rejected (028 §18 refusal rows preserved).
- Preserve provenance/audit (G-5): `sale.captured/voided/refunded` must still record a real `actor_user_id` and the resolved `(tenant, store, user, device)` scope, exactly as Option-Y produced them.

> **⚠ G-4 live-predicate gap — the load-bearing risk of this slice.** The two guards are **not** equivalent in *temporal* strength, and the plan must not pretend they are. **Verified this session:** Option-Y's `OperatorContextResolver` re-resolves the full predicate **live, per sale request** — active device (revoked excluded), membership not-revoked/not-deleted, role eligibility, and store-access eligibility. The canonical path (`AuthGuard → findActiveByRawToken`) checks only `scope==="pos_operator"` + token not-revoked + not-expired; it does **not** re-resolve membership/device/store-access — those were checked **once, at sign-in**. **And no code today propagates membership-, device-, or store-access-revocation to `auth_tokens.revoked_at`** (grep confirms the only `revoked_at` writers are connector-018 lifecycle + operator sign-out/takeover). A naive re-wire therefore **weakens** three predicate legs from live-per-request to point-in-time-at-sign-in: a manager whose membership/device/store-access is pulled **mid-shift** would keep authorizing sales until the 8h TTL or explicit sign-out. That **violates G-4** ("the envelope must not weaken any of them"). Carrying the `(tenant, user, device, store)` binding on the row is **necessary but not sufficient** — the binding is identifiers, not re-resolution. Phase 2.5 below names the mechanism that closes this; the re-wire (this phase) MUST NOT ship without it.

## Phase 2.5 — Uphold the live predicate under the envelope model (G-4) [G10]

> Closes the gap flagged in Phase 2. The plan must name **one** of the two mechanisms below; the owner/028 chooses which owns it. Either way it is **not silent** — G-4 depends on it. Both reuse the existing `revoked_at` column, so **no schema change (no G3 introduced)** — confirm this survives detailed design.

- **Option A — revocation reconciliation (recommended; 028 §9 territory).** When a membership is revoked/deleted, a device is revoked, or store-access is pulled, **propagate** to revoke the affected operator's live envelope `auth_tokens` row(s) (`UPDATE … SET revoked_at = now()` — the mechanism sign-out already uses). The next sale then fails immediately via the canonical path's existing not-revoked check, restoring live-equivalent behavior. **Dependency to state explicitly:** 028 §9 ("device/user/store revocation reconciliation") is the upstream owner of this propagation; this slice must either **wire** it (if DP-2-side) or **declare a hard dependency** on it landing. Today **no such propagation exists** (verified) — so absent Option B, this slice **introduces** the mechanism and owns it.
- **Option B — re-resolve at the guard.** Have the canonical `pos_operator` path (or a thin wrapper guard on the sale routes) re-run the membership/device/store-access checks per request, the way Option-Y did — keeping the envelope as the credential but restoring per-request predicate evaluation. Higher per-request cost; closest to today's behavior; avoids depending on reconciliation completeness.
- **Decision needed (carry to tasks):** A vs B is a plan→tasks open item, gated on whether 028 §9 reconciliation is guaranteed to cover all three revocation axes for the envelope. **Recommendation:** Option A if 028 §9 is authoritative and complete; Option B as the fail-safe if reconciliation coverage is uncertain. Do **not** ship Phase 2's re-wire without one of these in place.

## Phase 3 — Retire `PosOperatorSaleAuthGuard` for the sale routes [G10]

- Once Phases 1–2 hold, **retire** `PosOperatorSaleAuthGuard` on the three sale-write routes; **no parallel Option-Y path is retained** (a dual path re-creates the 028 §19 DOC-3 contract↔runtime mismatch — Clarifications 2026-06-11).
- Scope the retirement precisely: confirm `PosOperatorSaleAuthGuard` is not relied on by any non-sale route before removing/neutralizing it; if it has no remaining consumers, it can be deleted; if it does, leave it intact for those and only detach it from the sale routes.

## Phase 4 — Contract: new authorization-credential scheme + sale-route re-wire (OQ-5) [G2]

- Introduce a **new, distinct authorization-credential security scheme** in the OpenAPI contracts — e.g. `operator-authorization` or `pos-operator-envelope` — describing an **opaque `pos_operator` authorization bearer** carried as `Authorization: Bearer`.
- **MUST NOT** reuse 030's `operator-identity` scheme (identity-proof-only, JWT): labeling an authz credential as identity-proof is a category error that re-creates the DOC-3 mismatch (OQ-5 resolution).
- Apply the new scheme to `captureSale` / `recordVoid` / `recordRefund` in `packages/contracts/openapi/pos-sales/sales.yaml`, replacing the `clerkJwt` the routes carried under Option-Y (028 §19 DOC-3 — the rename **co-travels** with this slice for exactly these re-wired routes; broader DOC-1/2/4 cleanup is the separate, additive D4/030 work).
- Document the sign-in/takeover-confirm response envelope field in the contract.
- **Gate:** G2 — this is the contract/OpenAPI surface; it must be reviewed for scheme correctness and contract↔runtime consistency. (No G3: still no migration.)

## Test strategy (descriptive — tests authored in DP-2, not here)

- **Unit:** sign-in returns a non-empty envelope; the envelope resolves via `findActiveByRawToken` to a `{ kind:"token", scope:"pos_operator" }` principal that satisfies `PosOperatorAuthGuard` (closes D2); sign-out's `revoked_at` UPDATE invalidates a previously-returned envelope.
- **Integration (RLS-aware):** capture/void/refund authorized by the returned envelope succeed with the same membership/store/eligibility outcomes as Option-Y; a device-only or provider-JWT-only request is rejected; provenance (`actor_user_id`, resolved scope) unchanged. Reads on the correct pool (mirror the existing sale-auth integration RLS handling).
- **Regression:** `PosOperatorSaleAuthGuard` is no longer wired on the three sale routes and no parallel Option-Y path remains (proves A-3); `readSale`'s guard is unchanged but now satisfiable (proves the phantom is closed).
- **Contract conformance:** the new authz scheme is present, applied to the three sale routes, and is **not** 030's `operator-identity`; the sign-in response documents the envelope field.
- **Negative / non-disclosure:** missing/invalid/revoked/expired envelope, ineligible role, store-access miss all collapse to the same generic 401; no envelope material in logs.
- **Live-predicate (G-4) — the regression guard for Phase 2.5:** after a valid envelope is issued, revoking the operator's **membership**, **device**, or **store-access** mid-session **stops further sales** (the next capture/void/refund fails) — proving the envelope did not weaken live revocation vs. Option-Y. This test MUST fail against a naive re-wire that omits Phase 2.5, and pass once the chosen mechanism (A or B) is in place.

## Out of plan (sibling slices — do not implement here)

- **D3 (029)** provider-neutral identity link / resolver re-point — **SHIPPED** (PR #550); the resolution join key is **unchanged by this slice** (N-2).
- **D4 (030)** broader `clerkJwt`→role-named contract cleanup — additive; **SHIPPED** (PR #551). Only the DOC-3 sale-route scheme rename co-travels here.
- **D5** POS adopts/presents the envelope — POS-Pulse spec, downstream of D1; not authored here.
- **D6** POS offline-PIN re-anchor — POS spec; needs D3 + the D1/D5 envelope carrying `user_id`.
- **D7** device token reverts to device-scoped — follows D5.
- **OQ-3 / OQ-4** refresh + multi-distinct-device — **DEFERRED to the 028 boundary**; v1 ships no-refresh + inherited single-session-per-`(device,store)`.

---

> **Docs-only planning record.** No code, schema, contract, migration, or test is authored by this plan. `tasks.md` is **not** authored in this step. Dispatch to Data-Pulse-2 requires a **further** explicit, scoped owner approval after G10 dispatch-clearance. Phase order (return → re-wire → retire → contract scheme) is the recommended approach, not an executed change.
