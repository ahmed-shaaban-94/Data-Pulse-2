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

**No single feature is currently in active development.** Confirm via GitHub (open PRs, recent commits) before acting. Recent shipped work and documented partials:

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
