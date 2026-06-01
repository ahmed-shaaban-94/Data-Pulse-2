# Data-Pulse-2 — Agent Context

Multi-tenant SaaS rebuild for Data Pulse. The legacy `Data-Pulse` repo is reference only — never copy without re-spec'ing here.

## Agent OS / Maestro operating mode

**GitHub is the source of truth. Chat memory is advisory.**

Short prompts must be expanded from repo files, not from repeated user instructions. The prompt `"Use Agent OS. Execute slice X. Stop before commit."` is complete — Maestro resolves the full brief from the execution map.

Bootstrap read order for every agent session:

1. `git fetch origin && git pull --ff-only origin main` — always start from latest `origin/main`.
2. [.specify/memory/constitution.md](.specify/memory/constitution.md) — 14 Core Principles; source of truth for all design constraints.
3. [docs/agent-os/standing-rules.md](docs/agent-os/standing-rules.md) — hard operating rules (branch hygiene, forbidden gates, git discipline, stop conditions, reporting).
4. [docs/agent-os/maestro-playbook.md](docs/agent-os/maestro-playbook.md) — orchestration workflow (slice dispatch, parallel waves, post-merge closeout).
5. Active spec's `execution-map.yaml` — slice state, allowed/forbidden files, validation contract.
6. Active spec's `wave-status.md` — human-readable progress, findings, next recommended action.
7. GitHub PRs / CI checks / CodeRabbit reviews — current authoritative state for in-flight work.

Do not duplicate standing-rules content here. When in doubt about an operating rule, `standing-rules.md` governs.

## Constitution

[.specify/memory/constitution.md](.specify/memory/constitution.md) (v3.0.0) — read it when principle text matters; do not paraphrase from memory. Key principles: §II multi-tenant RLS, §III backend authority, §IV contract-first, §VIII reproducible releases (`[GATED]` required), §XII object safety, §XIV PII discipline.

## Active feature

**`009-inventory-stock-ledger` is IN PROGRESS on `main`** (7/15 slices merged, PRs #438–#444). **All remaining Docker-gated slices (US3–US6 etc.) are BLOCKED on the `009-CI-OPT` infra slice** — hosted CI must finish GREEN first (see below). `008-sales-transaction-capture` is **CLOSED** (2026-05-31, 16/16 slices, PRs #420–#435). Confirm current state via GitHub (open PRs, recent commits) before acting. Recent shipped work and documented partials:

- **`009-CI-OPT`** — hosted-CI reliability infra slice (owner-directed 2026-06-01, `[GATED]` `.github/**`). After the CI runner was switched self-hosted → GitHub-hosted `ubuntu-latest` (PR #446 — the self-hosted runner was **dead**, so `db-integration` had silently never completed across 009), the hosted lane surfaced accumulated breakage: stale migration-count assertion (PR #447), self-referential barrel import (PR #448), then a **25-min job timeout** (api RLS+coverage step ran ~21 min, job killed twice). `009-CI-OPT` (PR #449) bumps `db-integration` `timeout-minutes` 25→40 and drops `--coverage` from the blocking api step (dominant cost; suite still runs + gates; coverage **deferred** to local/manual — wave-status finding #8). **`main` has NO branch protection — CI is advisory; verify each PR's `db-integration` manually before merge.** US3–US6 stay parked until a **green hosted canary** lands. [specs/009-inventory-stock-ledger/](specs/009-inventory-stock-ledger/)

- **`009-inventory-stock-ledger`** — append-only stock-movement ledger with compute-on-read on-hand, **decoupled** from 008's gated live loop (the backfill reads CAPTURED sale rows; never subscribes to `sale.captured`). **7 of 15 slices merged 2026-05-31** (PRs #438–#444): SIGNOFF (no-`package.json` quantity value-object), SETUP, `[GATED]` CONTRACT (`inventory.yaml`) + `[GATED]` SCHEMA (`0014_inventory` — `stock_movements` + `stock_counts`, RLS SELECT+INSERT-only, no version column), ISOLATION-HARNESS, **US1-ONHAND** 🎯 (compute-on-read signed SUM + movement list), **US2-MANUAL** (`createStockMovement` — manual inbound/outbound/adjustment; write-off = reason-coded outbound; strict Zod DTO mass-assignment ban; audit-in-transaction; FR-022 cross-unit reject; allow-and-flag negative). **Two `[GATED]` deferrals for closeout** (both `packages/db/**`): movement **outbox emit** (new `INVENTORY_MOVEMENT_*` type in `OUTBOX_EVENT_TYPES`; US2 is audit-only); **established-unit concurrency guard** (DB UNIQUE trigger / advisory lock — `assertUnitMatchesEstablished` is best-effort under READ COMMITTED). Next: **US3-IDEMPOTENCY**. For slice state read the spec's `execution-map.yaml` + `wave-status.md`. [specs/009-inventory-stock-ledger/](specs/009-inventory-stock-ledger/)
- **`008-sales-transaction-capture`** — the FIRST immutable sale fact the SaaS owns (`sales` + `sale_lines` + void/refund terminal events). **CLOSED 2026-05-31**, all 16 slices merged: schema + OpenAPI contract (`[GATED]`), isolation harness, US1 capture, US2 delayed-sync, US3/US4 void/refund, US5 idempotency, US6 safety, LIFECYCLE (SI-012 data-class guard), WORKER (off-request `processedAt` + advisory mismatch processor), WIRING (consumer-side BullMQ registration + no-unbounded-path guard), POLISH (report-only k6 perf + ≥80% coverage), CLOSEOUT. **THREE documented deferrals (not blockers — merged work is correct + tested):** (1) the live capture→process loop is **`[GATED]`** — needs producer binding in `SalesModule` + `sale.captured` added to `OUTBOX_EVENT_TYPES` (gated `packages/db`) + imperative `SaleWorker.start()` in `apps/worker/src/main.ts`; until then `processed_at` stays NULL (inert, nothing reads it). `SaleWorker` is registered-but-NOT-self-started by design (do not make it self-start). (2) reconciliation-mismatch-rate signal emit (T092) — FR-031 *MAY*; §VII counter unregistered. (3) SC-010 perf report-only (no perf env; `loadtests/k6/sales-capture.js` ready). These are the scope of a future "008-live-loop" follow-up. [specs/008-sales-transaction-capture/](specs/008-sales-transaction-capture/)
- **`007-unknown-items-review-queue-api`** — Unknown Items Review Queue **API** (the dashboard-facing feature 006 deferred). Contract via #404; Wave 1 P1 MVP runtime via #405 (`0c1bec7`) + #406. **US7 reopen (#408), US8 bulk-dismiss (#409), and the US4/5/6 regression guards (#410) all subsequently MERGED** (2026-05-30) — the "dead CI runner" block from the interim handoff notes is resolved. Remaining 007 scope is polish/closeout per the spec's `execution-map.yaml`. [specs/007-unknown-items-review-queue-api/](specs/007-unknown-items-review-queue-api/)
- **`005-pos-catalog-sync-reconciliation`** — **FULLY CLOSED** 2026-05-29. Shipped 2026-05-23 to 2026-05-29. Waves 1 + 2 both COMPLETE on `main` (POS capture + reconciliation surface — link / create-product / conflict audit + metrics); auth-guard wiring complete on all five reconciliation routes (PRs #377 + #378). The deferred follow-up **`005-WAVE1-METRICS-MISMATCH-FOLLOWUP`** is now CLOSED — the multi-PR harness refactor (T532 + T550 + T551 + T552-mismatch-case) merged via PRs #389/#390, plus the T560 perf-flake preflight (#393/#394/#396) and full execution-map status reconciliation (#397, all 34 slices terminal with provenance). One interim deferral remains, tracked in `wave-status.md`: SC-008 p95/p99 perf assertions are report-only pending a dedicated perf environment (T560).
- **`006-unknown-items-review-queue`** — docs-only product brief; Claude-executable scope exhausted 2026-05-28 (10 of 23 slices closed via PRs #380, #381, #382, #383). Remaining 13 slices are reviewer-owned (T010–T019 per-US sign-offs) or external-gate-blocked on future API + UI feature specs that don't yet exist.
- **`004-platform-production-readiness`** — P7 exit-gate **PASS for exercised API/worker/outbox paths** as of 2026-05-21. P4 full signal-catalogue live-scrape coverage **PARTIAL** with explicit deferrals (DB pool, Redis, idempotency, auth-failure, RLS-failure, cross-tenant, suspicious-login signals not yet live-scraped). Authoritative status: [docs/production-readiness/004-closeout-status.md](docs/production-readiness/004-closeout-status.md). T483 partial documented in [docs/observability/operator-validation-report.md](docs/observability/operator-validation-report.md).

For slice state, always read the spec's `execution-map.yaml` and `wave-status.md` — do not rely on this file for task-level detail.

## Specs summary

- **`001-foundation-auth-tenant-store`** — shipped. Auth, tenant/store/memberships, audit pipeline, idempotency interceptor, outbox first slice all merged. [specs/001-foundation-auth-tenant-store/](specs/001-foundation-auth-tenant-store/)
- **`002-pos-operator-identity`** — specification + OpenAPI contracts only. POS app is a separate repo integrating exclusively via `packages/contracts/openapi/`. [specs/002-pos-operator-identity/](specs/002-pos-operator-identity/)
- **`003-catalog-foundation`** — complete. All 22 slices merged on main through PR #310. Schema modules, schema-shape tests, 5 gated SQL migrations (0007–0011), and Phase 3 RED+GREEN service-layer pairs all on main; all 5 findings resolved. [specs/003-catalog-foundation/](specs/003-catalog-foundation/)
- **`004-platform-production-readiness`** — P7 exit-gate PASS for exercised paths; P4 PARTIAL with explicit deferrals. See above and `004-closeout-status.md`.
- **`005-pos-catalog-sync-reconciliation`** — POS Catalog Sync + Reconciliation. **FULLY CLOSED** 2026-05-29 (shipped 2026-05-23 to 2026-05-29). Wave 1 (POS capture + dismiss + idempotency-mismatch audit + metrics) and Wave 2 (link + create-product + conflict + atomicity) both COMPLETE on `main`; auth-guard wiring complete on all five reconciliation routes (PRs #377 + #378). The `005-WAVE1-METRICS-MISMATCH-FOLLOWUP` harness refactor (T532 + T550 + T551 + T552-mismatch-case) is CLOSED via PRs #389/#390; T560 perf-flake preflight via #393/#394/#396; execution-map fully reconciled via #397 (all 34 slices terminal status with `merged_at_commit` provenance). Sole interim deferral: SC-008 perf assertions report-only pending a dedicated perf environment (T560). [specs/005-pos-catalog-sync-reconciliation/](specs/005-pos-catalog-sync-reconciliation/)
- **`006-unknown-items-review-queue`** — Unknown Items Review Queue, docs-only product brief. 10 user stories, 38 FRs, 9 SI requirements, 8 SCs. Spec/plan/Phase 0–1 artefacts + Agent OS coordination (T001–T023) merged on `main` via PRs #308 + #311; Claude-executable slice scope exhausted 2026-05-28 (10 of 23 closed via PRs #380, #381, #382, #383). Remaining 13 are reviewer-owned or external-gate-blocked. [specs/006-unknown-items-review-queue/](specs/006-unknown-items-review-queue/)
- **`007-unknown-items-review-queue-api`** — Unknown Items Review Queue **API** — the dashboard-facing feature 006 deferred, implementing over the shipped 005 surface. Planning chain + `[GATED]` OpenAPI contract extension (`ReviewQueueItem` projection, 3 new operationIds, `forbidden` 8th error code, list params) merged via PRs #400/#402/#404. **Wave 1 (Phase 2–5, P1 MVP) MERGED via PR #405 (`0c1bec7`)** + CodeRabbit follow-up #406 (`62d0906`): 7 slices — `forbidden`-category guard, shared `toReviewQueueItem` projection, isolation-harness terminal fixtures + sweep, review-safe list/dismiss/link/create projection swaps, list filter/sort/group extensions, and the new inspect `GET /{id}`. RED→GREEN, full catalog suite green (56 suites / 429 passed). All Wave-1 slices `status: merged`. **US7 reopen (#408), US8 bulk-dismiss (#409), and US4/5/6 regression guards (#410) subsequently MERGED 2026-05-30** (the interim "dead CI runner" block is resolved). Remaining: polish/closeout per the spec's `execution-map.yaml`. For slice state, read the spec's `execution-map.yaml` and `wave-status.md`. [specs/007-unknown-items-review-queue-api/](specs/007-unknown-items-review-queue-api/)
- **`008-sales-transaction-capture`** — first immutable sale fact (`sales` + `sale_lines` + void/refund terminal events), built over the shipped 005 POS ingestion seam (reuses Idempotency-Key interceptor, `sourceSystem+externalId` dedup, tenant-context/RLS, audit, outbox — no re-invention). **CLOSED 2026-05-31 — all 16 slices merged** (PRs #420–#435): SETUP/SIGNOFF, `[GATED]` SCHEMA (`0012` migration) + CONTRACT (`pos-sales/sales.yaml`), ISOLATION-HARNESS, US1–US6, LIFECYCLE, WORKER, WIRING, POLISH, CLOSEOUT. Money = string-backed value object (no `package.json` dep, gate A.6). **Three documented deferrals** (wave-status Active findings): live capture→process loop is `[GATED]` (producer binding + `sale.captured` in `OUTBOX_EVENT_TYPES` + `main.ts` `SaleWorker.start()` — `processed_at` stays NULL until then); reconciliation-mismatch-rate emit (FR-031 *MAY*); SC-010 perf report-only. Downstream reads of the sale fact (009 inventory, 012 reporting) are unblocked. [specs/008-sales-transaction-capture/](specs/008-sales-transaction-capture/)
- **`009-inventory-stock-ledger`** — append-only stock-movement ledger (`stock_movements` + `stock_counts`) with **compute-on-read** on-hand (signed SUM, no materialized balance), **decoupled** from 008's gated live loop (backfill reads CAPTURED rows; no `sale.captured` subscription). 15 slices / 45 tasks. **IN PROGRESS — 7/15 merged 2026-05-31** (PRs #438–#444): SIGNOFF, SETUP, `[GATED]` CONTRACT + `[GATED]` SCHEMA (`0014_inventory`, RLS SELECT+INSERT-only, no version column), ISOLATION-HARNESS, US1-ONHAND 🎯, US2-MANUAL (`createStockMovement`; allow-and-flag negative FR-024; cross-unit reject FR-022; mass-assignment ban FR-052; ad-hoc nullable product no auto-create FR-023; audit-in-transaction). Two `[GATED]` closeout deferrals (`packages/db/**`): movement outbox emit + established-unit concurrency guard. Next: US3-IDEMPOTENCY. For slice state read the spec's `execution-map.yaml` + `wave-status.md`. [specs/009-inventory-stock-ledger/](specs/009-inventory-stock-ledger/)

## What this repo does NOT own

POS application (separate repo). This repo owns SaaS backend, admin/dashboard frontend (separate feature, deferred), workers, infrastructure.

## Stack

- **Runtime**: Node.js 20 LTS · TypeScript 5.x strict · pnpm workspaces
- **Backend**: NestJS 11 (api + worker)
- **Data**: PostgreSQL 16+ with RLS · Drizzle ORM · explicit SQL migrations · Redis 7+ · BullMQ
- **Contracts**: OpenAPI 3.1 of record · Zod for runtime validation
- **Test**: Jest + Supertest + Testcontainers · `MIGRATION_TEST_ALLOW_SKIP=1` for Docker-less local runs
- **Observability**: pino · OpenTelemetry · Prometheus exporter (API `:9464`, worker `127.0.0.1:9091`)
- **Auth**: argon2id (`argon2` npm) · opaque revocable bearer tokens (API/POS) · httpOnly cookie sessions (dashboard humans)
- **IDs**: UUIDv7 with UUIDv4 fallback

Dashboard / web frontend is a separate future feature. OpenAPI contracts produced here are the only thing the dashboard depends on.

## Working agreement

See [docs/agent-os/standing-rules.md](docs/agent-os/standing-rules.md) for the full operating contract. Critical gates:

- Never commit / stage / push / merge / open PR without explicit instruction.
- Forbidden paths require `[GATED]` approval: `package.json`, `pnpm-lock.yaml`, SQL migrations, `packages/contracts/openapi/**`, `.github/**`.
- Untracked `bin/` and `externals/` are not part of any slice — leave them alone.
- Stop conditions in a slice brief mean stop and report. Do not silently expand scope.
