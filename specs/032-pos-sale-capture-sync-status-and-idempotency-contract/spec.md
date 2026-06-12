# Spec 032 — POS Sale Capture / Sync-Status / Idempotency Contract

**Status:** SPECIFY-ONLY — draft for owner review. No OpenAPI, no migration, no service code authored or implied here.
**Repo:** Data-Pulse-2.
**Parent:** Orchestrator Spec 029 §12 (`Q-DP2-SALE-SYNC-STATUS-IDEMPOTENCY-SPEC`), governed by Orchestrator Spec 030. This is the DP-2-repo-side spec; the OpenAPI/code/migration are authored by this DP-2 slice under DP-2 review.
**Relation to 028:** the 401/403 auth/refusal semantics + the capture guard are owned by 028, bound by reference. Gate **G10** applies. Not re-decided here.
**Excludes:** any `payments.confirm`/`settled_at` server settlement endpoint — that does NOT exist and must not be invented; tender settlement is POS-local (Spec 029).

---

## 1. Summary

Define the Data-Pulse-2 contract for the POS cashier sale's **server leg**: how a captured sale is received, deduplicated, given an authoritative server-side status, and how sync failures are classified for retry vs. operator repair. DP-2 is the contract/orchestration boundary (POS → DP-2 → Connector → ERPNext). POS constructs and sends the capture; DP-2 owns persistence, idempotency, authorization-refusal, status, and dead-letter classification. **POS never decides sale finality; the Console (later) consumes DP-2's status/repair surface.**

## Clarifications

> Append-only. These entries resolve **scoping** ambiguities only and route design/mechanism detail forward to `plan.md` / `data-model.md`. They do **not** re-decide any §13 owner decision; all four §13 items remain OPEN and are listed below as Deferred. No existing §-body text (especially §8 and §13) is altered by this session.

### Session 2026-06-12

- Q: What does the `sale.captured` consumer (§6) own — does DP-2's scope extend to downstream posting/forwarding to the Connector? → A: No. In-scope = verify the producer is bound and emits `sale.captured` in-transaction (F-5), plus a drain that advances the server-authoritative sale-status (§7). Any downstream posting/forwarding to the Connector/ERPNext is Connector-owned and OUT of scope here. (Scope-preserving; preserves the architecture invariant.)
- Q: Is the server-authoritative sale-status (§7) a persisted server-owned field or a derived projection of POS-local outbox state? → A: A persisted, server-owned status that DP-2 sets (the terminal observes, DP-2 decides — §7). Exact column/enum/transition modeling is deferred to `data-model.md`, not fixed in this spec. (Conservative; consistent with Constitution Principle III backend authority + IX source-of-truth.)
- Q: How is the failed-sync / NEEDS_REPAIR read list (§9) bounded for the later Console? → A: Tenant- and store-scoped, newest-first, with stable keyset/cursor pagination; generated-client only, consumed later by Console. Exact page-size/cursor shape is deferred to `plan.md` / contract design. (Conservative; honors Constitution per-tenant resource isolation + safe-404 cross-tenant semantics.)

**Deferred to owner (NOT decided here — see §13; both alternatives preserved verbatim):**

- AlreadyApplied 422 vs keep-409 (F-3): must not regress the live provenance-conflict 409. Owner decision; left OPEN.
- L1 Idempotency-Key engagement scope: capture-only vs all POS write ops. Owner decision; left OPEN.
- Repair authority: Console-mediated only, no POS-local override v1 (029 Q11 / 028 OQ-2 OPEN). Owner decision; left OPEN.
- `sales.yaml` ops authored contract-first vs alongside service work. Owner decision; left OPEN.

## 2. Verified runtime facts this spec builds on (DP-2 origin/main; re-verify at dispatch)

> Orchestrator Spec 030's evidence was pinned at DP-2 `6588e86`; current `origin/main` is `5212355`. Migrations still run through `0024_pairing_codes` → next-free slot `0025`. Re-verify against a re-fetched `origin/main` + open PRs before any code.

- **F-1 (capture exists; sync-status/repair do NOT).** `apps/api/src/catalog/sales/` ships capture with two-layer idempotency. The **read** side (server-authoritative sync-status query), the **failed-sync** classification surface, and any **repair/retry** op are the genuine gaps. (DP-2 spec 025 `console-sync-ops.yaml` is ERPNext-only — NOT this surface.)
- **F-2 (no server settlement).** `payments.confirm`/`settled_at` is a POS-local FSM timestamp, not a DP-2 endpoint. This contract covers capture / sync-status / idempotency / refusal / dead-letter ONLY — never tender settlement.
- **F-3 (AlreadyApplied 422 gap).** The void/refund contract `$ref`s `AlreadyApplied` (422) but runtime maps terminal re-delivery to `409` (`TerminalEventProvenanceConflictError`). Adding a distinct 422 without regressing the live 409 is an owner decision.
- **F-4 (L2 dedup LIVE).** `ON CONFLICT (tenant_id, source_system, external_id) DO NOTHING` ships; replay → same sale. **Pin it, do not rebuild.**
- **F-5 (`sale.captured` already registered).** `SALE_CAPTURED: "sale.captured"` is in `OUTBOX_EVENT_TYPES` since DP-008-LIVELOOP. Do **not** plan a registration PR — verify the producer is *bound* in capture.

## 3. Goals

- **G-1.** Define the **capture contract** (request envelope; `201` fresh / `200` replayed; idempotency semantics).
- **G-2.** Define **server-authoritative sale-status**, distinct from POS-terminal-local outbox status.
- **G-3.** Define the **refusal taxonomy** (401/403/409/422/retryable) mapped to Spec-029 §6 RETRYABLE vs NEEDS_REPAIR, the auth half bound to 028.
- **G-4.** Define **dead-letter / repair semantics** — DP-2 owns retryable-vs-needs-repair; never a silent drop; provenance preserved.
- **G-5.** Define the **read/repair surface** the later Console sync-ops UI consumes.
- **G-6.** Bind to 028 (auth) + the architecture invariant; **exclude** server tender settlement (F-2).

## 4. Non-goals

- No `payments.confirm`/`settled_at`/tender-settlement endpoint (F-2).
- No re-decision of 028 auth (bound by reference; G10).
- No POS UI / tender math. No Console UI (later, downstream). No ERPNext/Connector posting logic.
- No `sale.captured` outbox-event **registration** (F-5: already registered).

## 5. Repo ownership (binds Spec-029 §5 backend rows)

Backend sale capture / idempotency / auth-refusal / sale-status / dead-letter / sync-status-read = **Data-Pulse-2**. Capture-request construction = POS-Pulse. Sync-ops review/repair UI = Console (later). Architecture invariant: POS → DP-2 → Connector → ERPNext; no POS→ERPNext; DP-2 is the contract boundary.

## 6. Capture contract

- **Request envelope:** mirror the shipped `CaptureSaleRequest` DTO — sale lines, money in integer minor units, operator/device/store provenance, client-supplied idempotency/external key.
- **Success:** `201` fresh; `200` replayed (idempotent, same sale, no duplicate); a replay indicator in the contract.
- **Two-layer idempotency:** L1 = Idempotency-Key (the unused `idempotency_keys` seam — *engage it for capture*); L2 = atomic dedup (LIVE, F-4 — pin, don't rebuild).
- **`sale.captured`:** already registered (F-5) — specify it is **emitted in-transaction** and drained by a consumer; verify the producer binding.

## 7. Server-authoritative sale-status

DP-2 owns authoritative status, distinct from POS-local outbox UX (Spec-029 §6). Define: a status vocabulary the Console reads (captured / synced / failed-retryable / failed-needs-repair); the mapping to Spec-029 §6 terminal-visible states; the rule **the terminal observes, DP-2 decides** — POS never overrides.

## 8. Refusal taxonomy + dead-letter (binds 028)

| Condition | HTTP | 029 §6 mapping | Owner |
|---|---|---|---|
| Auth invalid | 401 | RETRYABLE (re-auth) | 028 (ref) |
| Forbidden (revoked/scope) | 403 | RETRYABLE→NEEDS_REPAIR if persistent | 028 (OQ-5) |
| Idempotency-key conflict | 409 | n/a (request-level) | DP-2 L1 |
| Provenance reuse | 409 | n/a | DP-2 (LIVE — do NOT regress) |
| Already-applied genuine replay | 422 (F-3 gap) | n/a | DP-2 (owner decision) |
| Validation failure | 422/400 | NEEDS_REPAIR | DP-2 |
| Transient (network/5xx) | — | RETRYABLE (backoff) | DP-2 |

Dead-letter: non-retryable → NEEDS_REPAIR with provenance intact, never silent drop; repair is Console-mediated (later), never POS-local override. Reconnect-auth-failure classification routes to 028 OQ-5.

## 9. Read / repair surface (for the later Console sync-ops UI)

Expose (generated-client only, consumed later by Console): sale-sync-status read; failed-sync list (NEEDS_REPAIR queue, tenant/store-scoped, newest-first); sale search / receipt lookup; audit/correlation timeline (028 provenance); repair/retry op (server-mediated, audited, acts only on DP-2-classified NEEDS_REPAIR, never a sale-fact rewrite). **These are VERIFIED-ABSENT today (F-1).**

## 10. Gates

G0 (repo truth, re-verify) · G2 (the `sales.yaml` §12 contract surface — produced here) · G3 (migration slot `0025`, verified next-free) · G4 (capture/refusal auth — bound to 028) · G5 (L1+L2 replay = no duplicate; L2 live) · G7 (outbox drain + dead-letter diagnostics) · G10 (auth boundary — 028 signed, bound by reference).

## 11. Implementation backlog (enumerated, NOT dispatched — serialize on single-writer sale files)

1. Engage L1 Idempotency-Key on capture (+ PG mirror). 2. Bind the `sale.captured` producer in capture (already registered — verify/bind, don't re-register) + worker consumer drain. 3. Server-authoritative sale-status field + read endpoint. 4. Refusal taxonomy wiring (bind 401/403 to 028; preserve live 409). 5. AlreadyApplied 422 path (F-3, owner-confirmed first). 6. Failed-sync / dead-letter classification + NEEDS_REPAIR quarantine. 7. Read/repair surface for Console. 8. Migration `0025` for new idempotency/status schema. 9. Contract tests + `sales.yaml` §12 ops (the artifact POS/Console pin to).

First slice on approval: **items 3 + 7** (read surface + status) — unblocks the Console lane, independent of the 422 decision.

## 12. Acceptance criteria

Accepted only if it: is DP-2-owned + SPECIFY-ONLY (the slice authors the OpenAPI/code/migration under DP-2 review, not pre-written); binds 029 §5 backend ownership + §12; defines capture (§6) reusing live L2 dedup; defines server-authoritative status (§7); refusal taxonomy + dead-letter bound to 028 (§8); the Console read/repair surface (§9); gates incl. G10/G2/G3/G5 (§10); the backlog without dispatching it (§11); **excludes server settlement** (F-2); does **not** re-register `sale.captured` (F-5); preserves the architecture invariant.

## 13. Open decisions (owner)

- AlreadyApplied 422 (F-3): distinct 422 vs keep 409 (no regression of live provenance-conflict).
- L1 engagement scope: capture only, or all POS write ops?
- Repair authority: Console-mediated only (029 Q11 / 028 OQ-2 OPEN) — confirm no POS-local override v1.
- `sales.yaml` ops authored contract-first or alongside the service work.

---

*Provenance: authored from Retail-Tower-Orchestrator Spec 029 §12 / Spec 030 governance on verified DP-2 `origin/main` evidence. SPECIFY-ONLY; the OpenAPI/migration/service code are a separate, owner-gated DP-2 implementation slice.*
