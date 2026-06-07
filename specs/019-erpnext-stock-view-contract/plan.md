# Implementation Plan: ERPNext live stock-view (Bin) read contract

**Branch**: `019-erpnext-stock-view-contract` | **Date**: 2026-06-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/019-erpnext-stock-view-contract/spec.md`

**Constitution**: v3.0.1

## Summary

019 authors the **`[GATED]` DP2 ↔ connector OpenAPI contract** by which live
ERPNext Bin (on-hand) quantities flow connector→DP2 to feed the 017 stock
reconciliation run — the 017-deferred `017-STOCK-VIEW-CONTRACT`, named by 018 as
arc handoff **019**. It is a **read-only, run-scoped view** contract: per the
signed 014 stock-impact decision (OQ-1), DP2 owns operational on-hand, ERPNext
owns valuation, read-down is rejected, and **no standing Bin mirror** exists. The
contract mirrors 012's pull/report idiom — DP2 EXPOSES a feed of wanted bin-view
requests the connector PULLS (`binViewPullRequests`, like `connectorPullPostings`)
and a report endpoint the connector POSTs live snapshots to (`binViewReportSnapshot`,
like `connectorAckOutcome`) — under `/api/connector/v1/erpnext`, authed by the
opaque machine `connectorBearer` (018 identity), keyed by the 014
`erpnext_warehouse_map`, with items in ERPNext terms (`erpnextItemRef`) translated
DP2-side to `tenant_product_ref` via the confirmed 013 `erpnext_item_map`.

**This planning pass is no-implement and authors no gated file.** The contract YAML
+ its conformance test, and the eventual DP2-side feed/report runtime, are
described in prose and sequenced in tasks.md as `[GATED]` / future slices. The 017
run-lifecycle rewire (sync `EMPTY_BIN_VIEW` → async request/await/report) is named
as a separate future 017-rewiring slice and is out of 019's scope.

## Technical Context

**Language/Version**: Node.js 20 LTS · TypeScript 5.x strict

**Primary Dependencies**: NestJS 11 (api + worker) · Zod (runtime validation) ·
OpenAPI 3.1 (contract of record) · pnpm workspaces. No new dependency — the
contract reuses the existing `connectorBearer` guard (018), `IdempotencyInterceptor`
(001/008), and the OpenAPI loader/conformance harness (`apps/api/src/openapi/loader.ts`,
non-recursive — loaded with an explicit `dir`, as `posting-feed.yaml` is).

**Storage**: PostgreSQL 16+ with RLS · Drizzle ORM · explicit SQL migrations. **019
adds NO new table and NO new migration** (FR-009: no standing Bin mirror). It READS
`erpnext_warehouse_map` (014, `0018`), `erpnext_item_map` (013, `0017`),
`stock_movements` (009, `0014`), and the 017 reconciliation tables (`0020`).
Run-scoped Bin evidence lands in the existing 017 `erpnext_reconciliation_result.detail`,
not a new column.

**Testing**: Jest + Supertest + Testcontainers (WSL — `reference_007_test_env`) ·
`MIGRATION_TEST_ALLOW_SKIP=1` for Docker-less local runs · CI runs Testcontainers.
OpenAPI structural conformance test mirrors `posting-feed.contract.spec.ts`.

**Target Platform**: Linux server (api + worker containers).

**Project Type**: Web service (multi-tenant SaaS backend) — contract + future
DP2-facing surface; the connector is a separate repo (ADR 0008).

**Performance Goals**: Report-only (no perf env — A-6). The feed page is bounded
(≤500 items/page, mirroring 012/009); the report payload is bounded per request.

**Constraints**: DP2 makes NO outbound HTTP (012 invariant); fail-closed RLS;
exact-decimal quantities (no float); non-disclosing cross-tenant 404; the
connector stays ignorant of DP2 product IDs (012 O-6).

**Scale/Scope**: Two operationIds + their schemas + a conformance test (the
`[GATED]` CONTRACT slice). The DP2-facing feed/report runtime and the 017 rewire
are sequenced as future slices, not built here.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Touch | Verdict |
|---|---|---|
| **§II Multi-tenant RLS / non-disclosure** | Feed + report scope on the connector principal's tenant; cross-tenant `requestRef`/cursor → non-disclosing 404; reads cross RLS-protected 013/014/009/017 tables. | **PASS** — scope from principal only (FR-005); safe-404 (FR-006); cross-tenant sweep required (research R7). No new RLS surface (no new table). |
| **§III Backend authority & data integrity** | Quantities exact-decimal strings, no float, no silent rounding; DP2 stays on-hand authority, ERPNext valuation never read down. | **PASS** — FR-008; exact-match compare lives in 017 (014 §6.3); no valuation field (SC-004). |
| **§IV Contract-first POS/connector integration** | New OpenAPI 3.1 contract under `packages/contracts/openapi/erpnext-connector/`; stable operationIds; explicit `security`; no raw DB entity; conformance test. | **PASS** — FR-001/002/011/013/015; `[GATED]` CONTRACT slice; mirrors `posting-feed.yaml`. |
| **§V Async work in workers** | The eventual consumption is a worker run (017); the 017 rewire to an async connector-fed view is named, not built. | **PASS (deferred)** — FR-018; out of 019 scope; precedent `017-RECON-WIRING`. |
| **§VI Test-first quality** | RED→GREEN conformance test; cross-tenant sweep; idempotent-replay test; classification fixture. | **PASS** — tasks.md sequences tests first; Testcontainers for any DB-backed surface. |
| **§VII Observable systems** | The feed/report carry `request_id`/correlation; no secrets/PII in the Bin view (quantities only). | **PASS** — canonical Error envelope with `request_id` (FR-014); no PII class data on this surface. |
| **§VIII Reproducible & versioned releases** | A new `packages/contracts/openapi/**` YAML is a forbidden surface needing `[GATED]` approval; **no migration / package.json / schema change** (no new table). | **PASS** — only the contract YAML is gated; no DB/dep change (FR-009). The gated slice records the approval. |
| **§IX Source-of-truth model** | Reconcile-not-merge: ERPNext Bin compared to DP2 on-hand, never summed; no read-down of valuation; authorities (009/ERPNext) unchanged. | **PASS** — FR-009/FR-017; faithful to signed 014 stock-impact (OQ-1). The strongest principle this spec serves. |
| **§X Retail temporal semantics** | Connector read timestamp preserved as received, never a security clock; DP2 server-clock stamps `recordedAt`. | **PASS** — FR-016. |
| **§XI Idempotency & external IDs** | Report requires `Idempotency-Key`; same key+body replays, different body → 409; feed pull is idempotent on `since`. | **PASS** — FR-004; reuses `IdempotencyInterceptor`, no new primitive. |
| **§XII Authorization & object safety** | Scope never body-supplied; strict DTOs (`additionalProperties:false`); object-level auth on `requestRef`; default-deny `connectorBearer`. | **PASS** — FR-005/FR-006/FR-013. |
| **§XIII Auditability & provenance** | A recorded report is correlated to its run/request; insert-only; no secret/PII leakage. | **PASS** — run correlation (US3); the 017 result already carries provenance. |
| **§XIV PII & data lifecycle** | The Bin view is quantities + opaque item refs — **no PII, no payment, no money** (014 reconciliation tables are explicitly NO money/PII). | **PASS** — no PII/payment field on the surface; nothing to classify/retain beyond run-scoped evidence. |

**Result: PASS, no violations.** The only forbidden surface touched is the
`packages/contracts/openapi/**` YAML, handled via a `[GATED]` slice (not authored
in this pass). No migration, no schema, no dependency change — the no-standing-mirror
decision (FR-009) deliberately keeps 019 off `packages/db`. Complexity Tracking is
therefore empty.

## Project Structure

### Documentation (this feature)

```text
specs/019-erpnext-stock-view-contract/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions + rationale + alternatives
├── data-model.md        # Phase 1 — entities (no new persisted table), wire shapes, RLS posture
├── spec.md              # Feature spec (user stories, FRs, SCs, clarifications)
├── tasks.md             # Phase 2 — dependency-ordered tasks (this chain)
├── analysis.md          # Cross-artifact consistency analysis
└── review.md            # Self-review + residual risks
```

### Source Code (repository root) — surfaces 019 TOUCHES (described, not built here)

```text
packages/contracts/openapi/erpnext-connector/
└── stock-view.yaml                 # [GATED] the 019 contract YAML (NOT authored in this pass)

apps/api/
├── src/openapi/loader.ts           # existing non-recursive loader (reused; explicit dir)
├── test/erpnext-connector/contract/
│   └── stock-view.contract.spec.ts # [GATED-adjacent] structural conformance (mirrors posting-feed.contract.spec.ts)
├── src/connector/                   # 018 connector identity / ConnectorAuthGuard (reused; not modified by the contract slice)
└── src/catalog/erpnext-reconciliation/
    └── erpnext-reconciliation.service.ts  # 017 service (consumes the feed/report in a FUTURE rewire slice — out of 019 scope)

apps/worker/src/erpnext-reconciliation/
└── reconciliation-run.processor.ts  # 017 ErpnextBinView seam / EMPTY_BIN_VIEW (the future report-backed impl lands in the 017-rewiring slice — out of 019 scope)
```

**Structure Decision**: 019 is a **contract-first** feature. The deliverable of the
buildable `[GATED]` slice is one OpenAPI YAML (sibling to `posting-feed.yaml`) plus
its structural conformance spec — the same shape and load convention 012 used. No
`packages/db` change (FR-009). The DP2-facing feed/report **runtime** and the 017
**rewire** are explicitly downstream/future slices captured in tasks.md so the
contract can be approved and pinned (unblocking the connector repo) before the
runtime is built — the exact pattern 012 followed (contract shipped first, the
015/connector feed runtime later).

## Complexity Tracking

> No Constitution violations — table intentionally empty. The no-standing-mirror
> decision (FR-009) removes the only candidate for added complexity (a Bin table).
