# Wave Status — `032-pos-sale-capture-sync-status-and-idempotency-contract`

> Human-readable summary of where the spec stands. 032 gives DP-2 a **server-authoritative
> sale sync-status** (distinct from POS-local outbox UX, §7), a **Console read/repair surface**
> (§9), and a **dead-letter classification** of sync failures into RETRYABLE vs NEEDS_REPAIR
> (§8) — never a silent drop (Principle V/XIII).

**Last updated:** 2026-06-12 by Ahmed Shaaban — **MVP + US4 SHIPPED (capability complete,
live drain-trigger wiring deferred).** Shipped in two PRs: **#553 (`00c1539`)** — MVP
(migration `0026`, status vocab, US1 status binding, US2 read/repair surface) — and
**#561 (`616af95`)** — US4 (dead-letter classifier + quarantine producer + read/repair
hardening). Both squash-merged to `main`.
**Spec:** `032-pos-sale-capture-sync-status-and-idempotency-contract`
**Base:** `main`.
**Status:** **Phases 1–4 + 6 SHIPPED.** The server-authoritative status, the Console
read/repair API, and the US4 classifier/quarantine **capability** are on `main`. The
quarantine producer is a **tested capability NOT yet auto-fired** from the live
`SaleProcessingProcessor` failure branch (deferred to a wiring slice, the 008 precedent).
**US5 (422 path) and the `sales.yaml` §12 ops remain GATED on OPEN owner decisions.**

### What shipped — MVP (PR #553 `00c1539`, "MVP, DRAFT")

- **`[GATED]` migration `0026_sale_sync_status`** (+ paired `.down.sql`) — the
  server-authoritative `sales.sync_status` column + the `sale_sync_deadletters` quarantine
  table (`uq_sale_sync_deadletters_open` partial-unique = one OPEN row per sale; fail-closed
  RLS; CHECK-constrained classification + status vocab). NO money/PII (§XIV). Drizzle schema
  `packages/db/src/schema/sales/sale-sync-deadletters.ts`.
- **Status vocabulary + transitions** — `apps/api/src/catalog/sales/sale-sync-status.ts`:
  `captured → synced | failed-retryable | failed-needs-repair`, server-clock stamped, **no
  POS override**, mapped to Spec-029 §6 (T005).
- **US2 read/repair surface (§9)** — `apps/api/src/catalog/sale-sync-ops/`: read-model
  service + controller (`DashboardAuthGuard` + `TenantContextGuard` + `RolesGuard`/`@Roles`,
  `toBody` projections, non-disclosing 404 on out-of-scope), strict Zod query DTO.
- **`[GATED]` contract** `packages/contracts/openapi/sale-sync-ops/sale-sync-ops.yaml` —
  4 operationIds, `cookieAuth` (human-only), `/api/v1/catalog/sale-sync-ops`:
  `consoleGetSaleSyncStatus`, `consoleListNeedsRepair`, `consoleGetSaleAuditTimeline`,
  `consoleRepairSaleSync` — mirrors the 025 namespace family + auth posture.

### What shipped — US4 dead-letter (PR #561 `616af95`, "DRAFT — capability, not yet wired")

- **T029 — dead-letter classifier** `apps/worker/src/sales/sale-sync-failure-classifier.ts`:
  pure §8 condition → §6 RETRYABLE / NEEDS_REPAIR. Worker-local vocab **pinned** to the 0026
  CHECK (no `apps/api` import — the AUDIT_QUEUE_NAME precedent). 401/403 **bound to 028 by
  reference** (G10) — auth is NOT re-decided here; the reconnect-auth-failure case routes to
  the 028 OQ-5 classification (flagged, not acted on).
- **T030 — quarantine producer** `apps/worker/src/sales/sale-sync-deadletter.producer.ts`:
  writes the `sale_sync_deadletters` row **and** advances `sales.sync_status` atomically in
  one `runWithTenantContext` transaction under tenant RLS. Idempotent against
  `uq_sale_sync_deadletters_open` (`ON CONFLICT … WHERE resolved_at IS NULL DO NOTHING`);
  never clobbers a concurrently-`synced` sale (§XI converge); provenance intact (028); no
  sale-fact rewrite (§IX); no money/PII/payload written or logged.
- **Read/repair hardening** — the §9 controller/read-model gained the repair-path polish on
  top of #553's MVP surface.
- **Tests** — worker `sale-sync-deadletter.spec.ts` **18/18** (Docker-free; `runWithTenantContext`
  mocked with a scripted client) covering the classifier vocabulary pin, T027 non-retryable →
  NEEDS_REPAIR, T028 transient → RETRYABLE + 028 OQ-5 routing, idempotent no-op insert,
  no-clobber-of-synced, object-safety not-found, and PII-safe failure logging. API
  `sale-sync-ops.unit.spec` extended.

### CodeRabbit / review (PR #561 — addressed in `23fd9e8` before merge)

Four findings raised by CodeRabbit, all fixed:

1. **Status drift on open-row conflict (real correctness bug).** `advanceStatus` was running
   even when `insertDeadletter` hit the open-row conflict (`quarantined === false`) — so a
   re-delivery carrying a **different** condition could rewrite `sales.sync_status` while the
   original open deadletter row stayed unchanged. Fixed: `advanceStatus` now runs **only when a
   fresh quarantine row was written** (`quarantined === true`); the first classification stands.
2. **`correlationId` UUID-or-null guard.** Added to `assertInput` — it is a UUID-typed column
   **and** logged as `correlation_id` on failure (§XIV PII boundary); a malformed value is now
   rejected at the input boundary instead of failing as `22P02` in SQL or leaking free text.
3. **Zod `saleRef` validation.** The §9 controller's `assertSaleRef` replaced its raw
   `SALE_REF_RE` regex with `z.string().uuid()` for parity with the controller-runtime Zod
   flow (behaviour-preserving — 400 `validation_failure` before any DB hit).
4. **Idempotency test strengthened.** The open-row-conflict case now asserts
   `statusAdvanced === false` and exactly 2 queries (no UPDATE), pinning the no-status-rewrite
   invariant from finding #1.

### CI / merge

- Both PRs squash-merged after **full green CI** (`fast` + `db-integration` + CodeRabbit).
  #561's CI re-ran green with the CodeRabbit fixes; the clean squash after #559 landed
  confirmed zero file overlap between 031 and 032.

### Phase status vs `tasks.md`

| Phase | Tasks | Status |
|---|---|---|
| 1 Setup | T001–T003 | done (pre-flight) |
| 2 Foundational | T004 `[GATED]` migration 0026 · T005 vocab · T006 RLS/index | **SHIPPED** (#553) |
| 3 US1 status (P1 MVP) 🎯 | T007–T011 | **SHIPPED** (#553) — status bound on capture + advanced on drain |
| 4 US2 read/repair (P1 MVP) 🎯 | T012–T020 | **SHIPPED** (#553) — Console lane unblocked |
| 5 US3 capture hardening (P2) | T021–T025 | **see deferral** (L2 dedup already LIVE — F-4; L1-engage scope) |
| 6 US4 taxonomy + dead-letter (P2) | T026–T030 | **SHIPPED** (#561) — classifier + quarantine producer |
| 7 US5 422-path (P3) | T031–T033 | **GATED — OPEN owner decision §13 item 1** (422-vs-keep-409) |
| 8 Polish / cross-cutting | T034 `sales.yaml` §12 · T035–T037 | T034 **GATED** (owner §13 item 4); coverage/quickstart per slice |

### Deferrals / open items (NON-blocking — explicit, not silent)

- **Live drain-trigger wiring (the title's "not yet wired").** The quarantine producer is the
  tested **capability**; it is **not** yet auto-fired from the `SaleProcessingProcessor`
  failure branch and is **not** registered in `worker.module.ts` (outside this slice's
  `apps/worker/src/sales/**` lock scope — the same deferral as 008's enqueue-wiring +
  metrics-emission). Until wired, US2's NEEDS_REPAIR list + repair op are non-inert **whenever
  a caller invokes the producer** (test/seed or the future trigger); the table is no longer
  write-dead. Wiring is a follow-up slice that touches the processor happy path + the module
  DI graph, where its F-invariants are reviewed.
- **Metrics emission (T030 §VII signals).** Deferred — the worker metric registry gates its
  label sets behind a cardinality review (FR-B-012) and `worker.module.ts` flags adding a
  `sale-processing` entry as forbidden/deferred. The quarantine row + status advance **are**
  the §VII data source the monitoring slice will count.
- **US5 422 AlreadyApplied path (Phase 7).** GATED on OPEN owner decision §13 item 1. If the
  owner keeps 409, this phase is dropped entirely. The live provenance-conflict `409` (F-3) is
  preserved regardless and regression-guarded.
- **`sales.yaml` §12 ops (T034).** GATED on owner decision §13 item 4 + Principle IV. The
  Console-facing read/repair contract shipped as `sale-sync-ops.yaml`; the capture-side §12
  ops on `sales.yaml` await that decision.
- **US3 L1 capture idempotency (Phase 5).** L2 `sourceSystem+externalId` dedup is already LIVE
  (F-4 — do NOT rebuild); engaging the platform L1 `idempotency_keys` seam on capture is
  capture-only scoped per §13 item 2 (broadening is OPEN — do NOT broaden).

> **Hard invariants upheld throughout:** do NOT rebuild L2 (F-4) · do NOT re-register
> `sale.captured` (F-5) · do NOT regress the live `409` (F-3) · do NOT invent server
> settlement (F-2) · do NOT re-decide 028 auth (G10) · preserve POS → DP-2 → Connector →
> ERPNext.
