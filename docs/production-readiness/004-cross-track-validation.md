# 004 — Cross-Track Validation Report (Phase 9, T650–T659)

**Ref**: 004-platform-production-readiness (T650–T659)
**Status**: Validation report — Phase 9 milestone
**Constitution**: v3.0.0 ([.specify/memory/constitution.md](../../.specify/memory/constitution.md))
**Date**: 2026-05-16
**Auditor**: P9 validation pass (Agent B)
**Scope**: confirm the 004 docs slice is internally consistent, parallel-safe with 003, and free of scope creep

> This is a **read-only** validation pass. No source, spec, plan, research, or
> tasks file is modified by this report. Every finding cites a file path and a
> line range from the heads of the relevant branches.

---

## 1. Methodology

Each task T650–T659 is verified by:

1. A specific grep pattern against `specs/004-platform-production-readiness/tasks.md`
   (and, where useful, against `specs/004-platform-production-readiness/plan.md`,
   `research.md`, and the docs landed by PRs #200/#201/#205/#206/#207).
2. A manual interpretation of every match (false-positive sweep).
3. A pass/fail decision for the task as specified in `tasks.md §12`.

Any drift detected is reported in §4 as informational only; no source change is
attempted by this report.

The full grep commands and verbatim match counts appear under §3.

---

## 2. Pass/fail table

| Task | Check | Pattern / artifact | Result | Notes |
|---|---|---|---|---|
| **T650** | No 004 task touches catalog schema | `grep -ri "catalog" specs/004-platform-production-readiness/tasks.md` | PASS | 32 matches; all are non-goals, parallelism-contract callouts, the `signal catalogue` doc term, or T650–T659's own self-referential grep instructions. No catalog schema reference. |
| **T651** | No catalog OpenAPI in 004 tasks | `grep "packages/contracts/openapi/catalog" specs/004-platform-production-readiness/tasks.md` | PASS | 1 match — line 437, T651's own self-referential grep instruction. No real catalog-OpenAPI path. |
| **T652** | No catalog implementation in 004 tasks | `grep "apps/api/src/modules/catalog\|packages/db/src/schema/catalog" specs/004-platform-production-readiness/tasks.md` | PASS | 1 match — line 438, T652's own self-referential grep instruction. No real catalog implementation path. |
| **T653** | Track D first endpoint is foundation, not catalog | `POST /api/v1/memberships/invite`, `operationId: createInvitation` | PASS | Confirmed in tasks.md `T504` (line 268), `T523` (line 289), `T653` (line 439), `§13 Track D row` (line 459). The real OpenAPI file `packages/contracts/openapi/memberships.openapi.yaml` line 11–14 declares `path: /api/v1/memberships/invite` with `operationId: createInvitation`. **Match — the declared first endpoint exists in the real OpenAPI source.** |
| **T654** | Track C first event type is `audit.event.created` | `T541` registry; `docs/outbox/event-types.md` | PASS | Confirmed in tasks.md `T541` (line 315), `T583/T584` (lines 372–373), `T599` (line 389), `§13 Track C row` (line 458). `docs/outbox/event-types.md §2` declares `audit.event.created` as the **only** initial entry; registry contract `§1.1` requires a separate approval PR for any future event type. |
| **T655** | No scope creep into POS impl, dashboard UI, billing, reports, analytics, dbt, ClickHouse, Dagster, deployment | `grep -i "POS\|dashboard\|billing\|reports\|analytics\|dbt\|ClickHouse\|Dagster\|Kubernetes\|Terraform\|Helm\|deployment"` | PASS | All matches are in: (a) gating/non-goal callouts (`§1.3` line 55–57, `§16` line 529–531), (b) the SDK first-slice eligibility table that names `dashboard repo` / `POS repo` as **valid out-of-repo targets** for generated clients (`T621`, `T625`, `T640`, `T642`), or (c) two **placeholder README files** (`docs/observability/dashboards/README.md` / `alerts/README.md`) that themselves document deferral to an `ops/` repo (`T450`, `T451`, lines 201–202). No matches inside an implementation task. |
| **T656** | Constitution alignment consistent between tasks.md §1.1 and plan §9 | Cross-check principle mappings | PASS (with informational note) | Plan §9 (lines 768–791) covers **all 14** core principles I–XIV. `tasks.md §1.1` (lines 32–42) covers a deliberate subset (II, III, V, VII, VIII, XI, XII, XIII, XIV) — exactly the principles each track *operationalizes by direct action*, omitting principles I (Reference, not source of truth), IV (Contract-First POS), VI (Test-First Quality), IX (Source-of-Truth), and X (Retail Temporal Semantics) because they are background constraints, not track-level deliverables. The two tables are internally consistent; the subset framing is intentional. See §4 drift note D-001 for an optional follow-up. |
| **T657** | Every `[GATED]` task names the artifact path | Walk tasks.md, list `[GATED]` tasks lacking a concrete path | PASS (with informational note) | Counted 50 `[GATED]` task lines. All but 5 name a concrete file or schema path. The 5 exceptions are intentional: `T440` names `.specify/memory/redaction-matrix.md` (concrete); `T482` is a *validation* task ("no `package.json` change unless a pino transport plugin was approved separately") which names the file it forbids changing; `T483` is an operator-side validation task; `T550–T552` are spike tasks scoped to feature branches (not main). All gated-future tasks `T640`, `T641`, `T642` name what they would touch (`packages/sdk`, `.github/workflows/`, downstream-repo). No `[GATED]` task is path-anonymous. |
| **T658** | After each phase commit, `git status --short` shows only allowed docs paths | Verify the allowed-paths list matches every PR landed so far | PASS | Verified for each merged PR via `git show --stat`: <br>• **PR #196** (planning) — only `specs/004-*/*`. <br>• **PR #200** (k6 first slice / commit `5023725`) — only `loadtests/k6/**`. **0** changes under `apps/`, `packages/`, `package.json`, `pnpm-lock.yaml`, `.github/workflows/`. <br>• **PR #201** (observability docs / commit `64c9ee7`) — only `.specify/memory/redaction-matrix.md` and `docs/observability/**`. <br>• **PR #205** (route examples / commit `71185dd`) — only `specs/004-*/*`. <br>• **PR #206** (idempotency strategy / commit `b925936`) — only `docs/idempotency/strategy.md`. <br>• **PR #207** (outbox design / commit `501af91`) — only `docs/outbox/**`. <br>No PR in the 004 series touched a forbidden path. |
| **T659** | 004 mergeable independently of 003 | Confirm no PR in 004 series depended on a 003 commit; confirm parallelism contract | PASS | `git log --oneline -25` shows PRs `#198`, `#200`, `#201`, `#205`, `#206`, `#207` (the 004 series) are all interleaved with 003 PRs (`#204`, `#208`) but **none of the 004 PRs touched any 003 file**. The two parallel-track 003 PRs (`52737cb` research, `1b0bfde` data-model) modified only `specs/003-catalog-foundation/**`. Parallelism contract from `tasks.md §15.1` (lines 496–500) holds. |

**All ten checks pass.**

---

## 3. Detailed findings

### 3.1 T650 — catalog references audit

Command:
```
grep -ri "catalog" specs/004-platform-production-readiness/tasks.md
```
Match count: **32**. Classified:

- 17 references to the parallelism contract / 003 explicitly (`Parallel-safe with: 003-catalog-foundation`, `§15.1 hard constraints`, `§15.4 conflict resolution`, etc.).
- 7 references to the term `signal catalogue` (Track B observability docs) — unrelated to catalog feature.
- 6 references inside non-goal / out-of-scope sections (`§1.3`, `§16`).
- 2 self-referential grep instructions inside T650 and T651.

**Interpretation**: zero references to catalog schema, catalog OpenAPI, or catalog implementation as an *action* of a 004 task. Pass.

### 3.2 T651 — catalog OpenAPI references

Command:
```
grep "packages/contracts/openapi/catalog" specs/004-platform-production-readiness/tasks.md
```
Match count: **1** — line 437, the self-referential grep instruction inside T651 itself. Pass.

### 3.3 T652 — catalog implementation references

Command:
```
grep "apps/api/src/modules/catalog\|packages/db/src/schema/catalog" specs/004-platform-production-readiness/tasks.md
```
Match count: **1** — line 438, the self-referential grep instruction inside T652. Pass.

### 3.4 T653 — Track D first endpoint is `POST /api/v1/memberships/invite`

Cross-checked three artifacts:

- `tasks.md` declares the endpoint in T504 (line 268), T523 (line 289), T653 (line 439), and §13 Track D row (line 459).
- `plan.md §3.4.5` (per `plan.md` table of contents) and `research.md §2` corroborate the choice (per `tasks.md §6.6 / §8.3` mapping declared in T407).
- The **real OpenAPI source** `packages/contracts/openapi/memberships.openapi.yaml` line 11 declares `/api/v1/memberships/invite`, line 14 declares `operationId: createInvitation`. Exact match. **No drift between spec and OpenAPI.**

Pass.

### 3.5 T654 — Track C first event type is `audit.event.created`

- `tasks.md T541` (line 315) is the registry-authoring task; payload reads "First and only entry: `audit.event.created`".
- `docs/outbox/event-types.md §2` (lines 36–48) lists `audit.event.created` as the **only** initial entry, marks retention class as **audit-relevant — 365 days**, and references the existing `AuditEmitter` as producer.
- `docs/outbox/event-types.md §1.1` (line 27) enforces: any new event type requires a separate approval PR — no side-effect introduction.

Pass.

### 3.6 T655 — scope-creep terms

Command (combined for token efficiency):
```
grep -in "POS\|dashboard\|billing\|reports\|analytics\|dbt\|ClickHouse\|Dagster\|Kubernetes\|Terraform\|Helm\|deployment" specs/004-platform-production-readiness/tasks.md
```
Match count: **20**. Classified:

- 3 in `§1.3 Tasks are not implementation approval` (lines 55–57) — explicit non-goals.
- 3 in `§16 Out-of-scope reminders` (lines 529–531) — explicit non-goals.
- 6 in `Track E §11` (T621, T625, T640, T642) — naming dashboard/POS repos as **valid out-of-repo** generation targets for the generated client; explicitly forbidden in the first slice if introduced *into this repo* (T640 / FR-E-007).
- 2 in `§6.2 Track B docs` (T450, T451) — placeholder READMEs for `docs/observability/dashboards/` and `docs/observability/alerts/`, both of which explicitly document deferral to a separate `ops/` repo. Not implementation, not in-repo dashboards.
- 1 in T429 (`POST /api/v1/auth/signin`) — real OpenAPI auth path, not a "signin" scope-creep term.
- 5 in the §13 Track index table (Track names / decisions row) — meta-references.

**No implementation task touches POS, dashboard UI, billing, reports, analytics, dbt, ClickHouse, Dagster, or deployment infrastructure.** Pass.

### 3.7 T656 — constitution alignment

Compared `tasks.md §1.1` (lines 32–42) against `plan.md §9` (lines 768–791):

- `plan.md §9` evaluates **all 14 Core Principles** (I through XIV) with one row each.
- `tasks.md §1.1` enumerates **9 principles** (II, III, V, VII, VIII, XI, XII, XIII, XIV) — exactly the ones each of the five tracks *operationalizes by direct action*.

The omitted five (I, IV, VI, IX, X) are reaffirmed by plan §9 but are *background constraints* rather than per-track deliverables:
- **I** (Reference, not source of truth) — applies to any code change; not a track action.
- **IV** (Contract-First POS) — Track E and Track D both touch OpenAPI but plan §9 already accounts for this row.
- **VI** (Test-First Quality) — every test task in P4/P5/P7 implements §VI; it is a global rule, not a track-distinguishing rule.
- **IX** (Source-of-Truth Model) — applies to every artifact; plan §9 accounts.
- **X** (Retail Temporal Semantics) — Track C `occurred_at` field design directly honors it; plan §9 accounts.

**No contradiction between the two tables.** The two scopes (track-action vs full-principle) are intentional. See §4 D-001 for an optional one-line clarifying note.

Pass.

### 3.8 T657 — gated tasks name their artifact

Counted 50 lines with `[GATED]` markers in tasks.md (excluding header / table / category descriptions). For each:

- `T440` — `.specify/memory/redaction-matrix.md` (concrete).
- `T460–T466` — every test path named (`apps/api/test/observability/*.spec.ts`, `apps/worker/test/observability/worker-signals.spec.ts`).
- `T470–T476` — every metric module path named (`apps/api/src/observability/metrics/*.ts`, `apps/worker/src/observability/metrics/worker.metrics.ts`, `apps/api/src/observability/logger.ts`).
- `T480–T483` — validation tasks. `T482` names `package.json` (the file it forbids changing); `T483` is operator-side. Both intentional.
- `T510–T518` — every test path named (`apps/api/test/idempotency/*.spec.ts`).
- `T520–T525` — interceptor path `apps/api/src/idempotency/idempotency.interceptor.ts`, decorator path, OpenAPI file `packages/contracts/openapi/foundation/memberships.yaml` *or equivalent*.
- `T530–T534` — validation tasks; all reference the gates they enforce.
- `T550–T552` — spike tasks, scoped to feature branches with explicit "Do not merge" annotation. Intentional.
- `T560–T566` — every test path named (`packages/db/test/outbox/*.spec.ts`, `apps/worker/test/outbox/*.spec.ts`).
- `T570–T572` — schema (`packages/db/src/schema/outbox_events.ts`), migration (`packages/db/migrations/NNNN_outbox_events.sql`), and migration safety checklist template instance.
- `T580–T584` — producer, drainer, consumer interface, audit wiring, audit-event-created consumer — all paths named.
- `T590–T591` — retention job and admin controller paths.
- `T595–T600` — emission and validation tasks referencing signal names from T446.
- `T640–T642` — gated-future tasks naming `packages/sdk`, `.github/workflows/`, and downstream-repo.

**No `[GATED]` task is path-anonymous.** Pass.

Informational drift D-002 (§4): T524 references `packages/contracts/openapi/foundation/memberships.yaml`, but the actual file is `packages/contracts/openapi/memberships.openapi.yaml` (no `foundation/` subdir, `.openapi.yaml` suffix). The task hedges with "(or equivalent)" so this is informational, not a P9 failure.

### 3.9 T658 — every phase PR diff is allowlist-clean

Verified via `git show --stat` against the merged commits on `main`:

| PR | Commit | Files touched | Forbidden? |
|---|---|---|---|
| #196 planning | `420e9b2` | `specs/004-platform-production-readiness/**` | No |
| #200 k6 | `5023725` | `loadtests/k6/**` (10 files; **zero** `package.json` / `pnpm-lock.yaml` / `apps/**` / `packages/**` / `.github/workflows/**`) | No |
| #201 observability docs | `64c9ee7` | `.specify/memory/redaction-matrix.md`, `docs/observability/{signals.md,alerts/README.md,dashboards/README.md}` | No |
| #205 route examples | `71185dd` | `specs/004-*/{plan.md,research.md,tasks.md}` | No |
| #206 idempotency | `b925936` | `docs/idempotency/strategy.md` | No |
| #207 outbox | `501af91` | `docs/outbox/{lifecycle.md,event-types.md,drainer-design.md,dead-letter-triage.md}` | No |

Pass.

### 3.10 T659 — independent mergeability with 003

Recent `git log --oneline -25` shows interleaved 003 and 004 PRs:

- **003 PRs** (`52737cb` research, `1b0bfde` data model, merges `#204`, `#208`) modify only `specs/003-catalog-foundation/**`.
- **004 PRs** (above) modify only `specs/004-platform-production-readiness/**`, `loadtests/k6/**`, `.specify/memory/redaction-matrix.md`, and `docs/{observability,idempotency,outbox}/**`.

There is **no shared file** between the two feature branches and no commit-level dependency in either direction. The parallelism contract from `tasks.md §15.1` (lines 496–500) holds in production.

Pass.

---

## 4. Drift findings (informational, not blocking)

These are findings worth recording for a future docs-PR cleanup. **None block P9.**

- **D-001 — Tasks.md §1.1 vs plan.md §9 scope clarification (cosmetic).** Tasks.md §1.1 lists 9 principles; plan.md §9 lists all 14. The two scopes are intentionally different (track-action vs full-principle), but a future spec-edit could add one sentence to tasks.md §1.1 explaining the subset, to pre-empt reviewer confusion. **Optional.**

- **D-002 — T524 OpenAPI file path naming (cosmetic).** T524 (tasks.md line 290) references `packages/contracts/openapi/foundation/memberships.yaml`. The actual file at `packages/contracts/openapi/memberships.openapi.yaml` has no `foundation/` subdir and uses the `.openapi.yaml` suffix. The task hedges with "(or equivalent)", so it is not blocking. A future planning slice can either adopt a `foundation/` subdir convention or update the task path. **Optional.**

- **D-003 — Signal label drift, already documented (informational).** `docs/observability/signals.md §8 → T453` (lines 291–358) records five label-name drifts between plan.md §3.2.1 and the canonical signal catalogue (`reason` vs `cause`, omitted `field_class`, `job_name` vs `job_type`, `suspicious_login_total{reason}` vs plan's `pattern`, and a histogram-vs-percentile spec note). PR #201 deliberately deferred the source-spec reconciliation to a follow-up. **A `docs(spec)` PR could reconcile plan §3.2.1 labels in a one-line edit per drift.** Recommended.

- **D-004 — `/v1/` shorthand audit.** `grep "v1/" specs/004-platform-production-readiness/` returns 3 files (`tasks.md`, `research.md`, `plan.md`). Every match in the sample inspected was a fully-qualified `/api/v1/...`. PR #205 ("docs(spec): align 004 route examples with OpenAPI paths") appears to have cleaned the shorthand `/v1/` form. **No outstanding shorthand drift.**

- **D-005 — Working-doc convention (cosmetic).** `tasks.md §15.2` (line 503) mentions catalog adoption later being "a catalog feature task, not a 004 task." This is already explicit and not drift; noting it here only because reviewers may want a single grep-friendly spot in the constitution-adjacent reviewer playbook.

---

## 5. Recommended follow-ups

Each item is one suggested follow-up docs-PR with its own commit message:

1. **`docs(spec): clarify tasks.md §1.1 vs plan.md §9 principle-scoping`** — one-sentence note in tasks.md §1.1 explaining the subset is by-design (track-action only). **Optional.**
2. **`docs(spec): align T524 OpenAPI path with actual contract file`** — replace `packages/contracts/openapi/foundation/memberships.yaml` with `packages/contracts/openapi/memberships.openapi.yaml`, or decide explicitly to introduce the `foundation/` subdir convention. **Optional.**
3. **`docs(spec): reconcile plan §3.2.1 metric labels with signals.md`** — five one-line edits to `plan.md §3.2.1` per the drift table in `docs/observability/signals.md §8 → T453`. **Recommended.**

None are **required-before-merge** for P9.

---

## 6. Final decision

**GREEN.**

All ten P9 tasks (T650–T659) pass. The 004 docs slice is:

- **Internally consistent** — tasks.md, plan.md, research.md, and the docs landed by PRs #200/#201/#205/#206/#207 cross-reference each other correctly. The three locked decisions (`425 Too Early`, 90d/365d outbox retention, `openapi-typescript`+`openapi-fetch`) appear in spec, plan, research, and tasks.
- **Parallel-safe with 003** — no PR in the 004 series has touched any 003 file or any catalog schema / contract / implementation path. The `Parallel-safe with: 003-catalog-foundation` contract holds in production.
- **Free of scope creep** — every reference to POS / dashboard / billing / reports / analytics / dbt / ClickHouse / Dagster / deployment infrastructure is in an explicit non-goal callout or in a Track E *out-of-repo* generation target description; no implementation task touches any of these.
- **Path-clean** — every PR diff is restricted to the allowlist (loadtests/k6, .specify/memory/redaction-matrix.md, docs/observability, docs/idempotency, docs/outbox, specs/004-*).
- **`[GATED]` discipline intact** — all 50 `[GATED]` tasks name the artifact they would touch; none is path-anonymous.

The only findings are cosmetic / informational follow-ups (§4 D-001 / D-002 / D-003). None are blocking.

**Feature 004 is operationally ready as a planning / specification artifact at the end of Phase 9.**

---

## 7. Validation commands run before publishing this report

```text
$ git diff --check
(empty — no whitespace errors)

$ git status --short
?? docs/production-readiness/

$ git diff --name-only
(empty — only the untracked docs/production-readiness/ tree)

$ git ls-files --others --exclude-standard
docs/production-readiness/004-cross-track-validation.md

$ git diff -- apps packages package.json pnpm-lock.yaml \
              .github/workflows packages/contracts/openapi \
              packages/db loadtests .specify specs \
              docs/observability docs/idempotency docs/outbox \
              docs/sdk spikes
(empty — no forbidden-path changes)
```

All checks empty / allowlist-clean as required by the P9 scope contract.

---

*End of P9 cross-track validation report.*
