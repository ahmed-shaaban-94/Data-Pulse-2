# 017 Contract Intent — operator reconciliation/repair API

> **Planning artifact, not the contract.** Following the 014/015 precedent, the
> actual OpenAPI 3.1 contract is authored under
> `packages/contracts/openapi/erpnext-reconciliation/reconciliation.yaml` in its
> own **`[GATED]`** `packages/contracts` slice (Constitution §IV/§VIII). This file
> records the planned surface so `/speckit-tasks` can sequence the gated contract
> slice. The 012 `posting-feed.yaml` is **read-only input** — 017 adds NO machine
> contract (FR-017/018).

## Surface (all `cookieAuth` / DashboardAuthGuard — human Tenant Admin, FR-018)

Namespace: **`/api/v1/catalog/erpnext-reconciliation`** — the real human-admin
convention 014's `erpnext-warehouse-map` controller uses (`@Controller()` empty +
full per-method `api/v1/catalog/...` paths). NOT `/api/admin/...` (no existing
module uses that prefix), NOT `/api/connector/...` (machine), NOT `/api/pos/...`
(device). Paths below are relative to that namespace.

| operationId | Method + path | Story | Purpose |
|---|---|---|---|
| `listPostingBacklog` | `GET /postings/backlog` | US1 🎯 | Paginated/sortable/groupable list of 015 `permanently_rejected` dead-letters for the tenant — class, originating ref, provenance, structured reason, dead-letter time. Filter by store + class. |
| `repairPosting` | `POST /postings/{workItemRef}/repair` | US2 | Idempotent repair of a posting dead-letter (re-evaluate 015-RESOLVE → re-offer; `x-idempotency: required`, reuse the existing interceptor). Echoes the recorded outcome (`eligible_again` / `still_failing` / `no_op_echo` + `resolvedDocumentRef`). |
| `triggerReconciliationRun` | `POST /runs` | US3 | Trigger an on-demand stock reconciliation run for a `(tenant, store)`; returns the run id (the async run is worker work). `x-idempotency: required`. |
| `getReconciliationRun` | `GET /runs/{runId}` | US3 | Run status + summary counts by class. |
| `listReconciliationResults` | `GET /runs/{runId}/results` | US3 | Paginated classified mismatch report (014 vocabulary). |
| `repairStockMismatch` | `POST /runs/{runId}/results/{resultId}/repair` | US3 | Idempotent re-map / re-sync for an actionable stock-mismatch class. |

> Full paths, e.g. `POST /api/v1/catalog/erpnext-reconciliation/postings/{workItemRef}/repair`.

## Contract invariants (must appear in the YAML)

- **Auth**: `cookieAuth` only (human session). No `connectorBearer`, no `clerkJwt`.
- **Wire projections (§IV)**: explicit `toBody` shapes — never raw DB rows; no
  `tenant_id` in bodies (implicit in the authenticated principal); no credential
  hashes; money (if any value appears) exact-decimal string, never float.
- **Strict request bodies (§XII)**: `additionalProperties: false`; body-supplied
  tenant/store/server-owned fields rejected → `validation_failure` (400).
- **Idempotency (O-3)**: repair + run-trigger require `Idempotency-Key` (reuse the
  existing `IdempotencyInterceptor` — no new primitive); same-key replay → 200
  `Idempotent-Replayed: true`; a repair of an already-`posted` posting echoes the
  stored `documentRef` (never a 2nd document).
- **Non-disclosure (§II/§XII)**: a cross-tenant / out-of-scope `workItemRef` /
  `runId` / `resultId` → non-disclosing `not_found` (404). Identical shape for
  cross-tenant, out-of-scope, and absent.
- **Closed error set**: the canonical envelope `{ error: { code, message,
  request_id, details? } }` — `validation_failure`, `not_found`,
  `idempotency_key_conflict`, `forbidden` (RBAC), `system_failure`, plus the 401
  session refusal. Matches `auth.openapi.yaml` / `pos-sales` shape verbatim.
- **Mismatch vocabulary**: stock classes = 014's set; posting categories = 015's
  set; the orthogonal `resultState` enum (`open|repaired|accepted`) is 017's own
  (research R4). 017 invents no mismatch class.
- **Mutation boundary**: nothing on this surface mutates the 008 sale fact or the
  009 ledger; repair transitions only 015 posting state / 017 result state (§IX).
- **Audit (FR-014)**: every run trigger + every repair emits a platform
  `audit_events` row **in the same transaction** as the state write (actor +
  tenant + store + target ref + outcome, no raw payloads/PII) via a **NEW
  in-transaction path** — a direct `INSERT INTO audit_events` on the same tx
  client. **NOT** the async `@Auditable` interceptor 013/014/015 use (post-response
  BullMQ enqueue, not in-tx) and **NOT** `insertAuditEvent` (forbids in-tx use) —
  neither gives the FR-014 rollback atomicity. This is the platform
  audit-of-record; the `erpnext_reconciliation_repair_attempt` / `…_run` rows are
  017's **operational** trail, written in the SAME transaction — both
  authoritative for their purpose, never one without the other (resolves analysis
  U1; review HIGH-finding correction).
- **Result vs attempt (U1)**: a stock-mismatch repair writes BOTH the append-only
  `repair_attempt` (audit) AND transitions `erpnext_reconciliation_result.result_state`
  `open→repaired` atomically; `result_state` is the current workflow status,
  `repair_attempt` is the immutable history.
