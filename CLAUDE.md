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

## Active feature — current state (pointer)

> **GitHub PRs/CI + each spec's `execution-map.yaml`/`wave-status.md` are the source of truth.**
> The full multi-spec arc history was moved to
> [docs/agent-os/active-feature-log.md](docs/agent-os/active-feature-log.md) to keep this file
> lean — read that log when you need historical narrative; read the spec files for slice state.
> **Always `git fetch` + check open PRs before acting** (chat memory is advisory).

- **ERPNext arc (011→025):** all DP2-side specs SHIPPED on `main`. The remaining frontier is
  **external/gated** — cross-system live validation against the connector repo
  (`Retail-Tower-ERP-Next-Connector`) + a staging ERPNext (epic #524). 019 stock-view loop is
  **LIVE-VALIDATED**; 020 (health) / 021 (product-recon) / 025 (console read-model) SHIPPED;
  023 is **PLAN-ONLY** (owner gate, #521); 016 (tax/fiscal-egypt) on-hold.
- **028 auth-boundary arc (D3/D4 + keystone D1/D2):** 029 (provider-neutral identity link) +
  030 (auth-contract cleanup) + **031 (operator-authorization envelope, the keystone)** all
  SHIPPED 2026-06-12. **032** (sale sync-status + read/repair + dead-letter) MVP + US4 SHIPPED.
  **033** (surface provider-neutral `user_id` on the POS operator response — the §16 chain's
  last hop, unblocks POS-017 offline-PIN re-anchor): SPECIFY (#564) → planning (#565) →
  **IMPLEMENTED & SHIPPED #567 (`c5e1c5d`) 2026-06-13.** `user_id` (= `users.id`) is now an
  additive `required` field on `PosOperatorSummary` at all 3 `signed_in` emit-sites (incl.
  takeover replay); `[GATED]` contract `additionalProperties:false` retained. unit 48/48 +
  integration 47/47 GREEN; no migration/envelope/resolution change. **Open cross-side input
  (not a blocker):** POS-Pulse must confirm strict-vs-lenient response validation — if strict,
  the POS-Pulse contract-pin update must accompany this `additionalProperties:false` schema
  bump. (DP-2 raised it to POS-Pulse — note on their `017` spec dir, PR #388.)
- **035 settlement/receivables arc (parent contract-producer):** SPECIFY → gated plan →
  owner decisions (OQ-7→**7-C** DP-2-owned operational truth + ERPNext valuation projection;
  OQ-4→**CARVE** non-reversal happy-path only, reversal deferred to DP-026 close; OQ-2→**tax
  deactivated** v1 under ADR-0003) → signed decision record → **G2 contract** (#574) →
  **G3 migration 0027** (#576, 7 tables incl. composite-FK UNIQUE target keys) → runtime
  **T030–T034 ALL SHIPPED 2026-06-15**: T030 receivable open-from-intent + Console read/list
  (#579), T031 cash application 7-C (#580), T032 claims + remittance reconciliation (#581,
  +3 Codex fixes: balance-moves-on-partial/over, payer-ownership, re-lock-claimed), T033
  authz/isolation (#582), T034 `settlement_receivable_total` signal (#583). **2 carried Codex
  findings (raised on the T031/#580 + T030/#579 review threads) FIXED & SHIPPED via PR #584
  (`2976e46`)**: (a) non-positive apply `amount` → 500 (now DTO `>0` → clean 400;
  `remittedAmount` deliberately stays `>=0` — a 0-remittance = valid full rejection;
  per-field-semantic, NOT blanket `>0`), (b) `claimMetadata` wrongly persisted into the
  `tax_placeholder` column (now null; `claimMetadata` stays an accepted-but-unpersisted opaque
  DTO field in v1 — drop-the-write, no gated migration). Full settlement suite 102/102 +
  tsc clean. Deferred by design: reversal-compat (DP-026), connector ERPNext posting
  (011-DR-POSTING-R1), tax/VAT (G6/ADR-0003), and the 5 downstream children (POS 020,
  Console 017/018/019, Connector 009).
- **Open follow-ups (non-blocking):** #524 (ERPNext live-leg epic), #529 (OTel boot hang),
  #531 (019 multi-window), #523 (020 dark-detection); 032's live drain-trigger wiring + US5
  422-path (gated); **db-integration 57P01 infra flake** (140 per-suite containers +
  un-closed pool killed on a sibling container stop; random unrelated victim suite; own
  `[GATED]` infra PR pending — diagnose victim+error before re-running any red db-integration).
  See each spec's `wave-status.md`.

For slice state, always read the spec's `execution-map.yaml` and `wave-status.md` — do not rely
on this file for task-level detail.

<details>
<summary>Full arc history (extracted)</summary>

The complete `## Active feature` + `## Specs summary` narrative (specs 001→032) now lives in
[docs/agent-os/active-feature-log.md](docs/agent-os/active-feature-log.md). It is
reference-on-demand and may lag the spec files.

</details>

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
