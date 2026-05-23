# Implementation Plan: Unknown Items Review Queue

**Feature ID**: 006
**Spec**: [spec.md](./spec.md) (drafted + clarified 2026-05-23)
**Constitution**: v3.0.1 ([../../.specify/memory/constitution.md](../../.specify/memory/constitution.md))
**Branch**: planning artifacts only — implementation is deferred to downstream features (see §9)
**Status**: Draft (Phase 0–1 planning only — no code, no migrations, no contract YAML, no UI)
**Created**: 2026-05-23
**Owner**: Ahmed Shaaban

> **Scope guardrail**: 006 is a **product-level UX specification only** (spec §0). This plan therefore does **not** schedule code, schema migrations, OpenAPI contracts, NestJS modules, React components, or any other implementation artifact. The implementation path is split across (a) a **future API feature** that defines the read/action contract surface the queue requires, and (b) a **future UI feature** routed through Impeccable (spec §11). Both downstream features are out of scope for this plan; they will produce their own specs, plans, and tasks. This planning artifact also does **not** author `tasks.md`; that is a separate `/speckit-tasks` invocation if and when a single 006-internal task is justified (see §9.5).

---

## 1. Summary

006 defines how authorized reviewers (tenant admins, tenant owners, store operators) safely review, filter, inspect, and act on unknown POS-sourced catalog items captured by 005. The product-level guarantees the spec pins are:

- **Permission-aware visibility** scoped per 005 / 003 RLS (tenant-wide for admins, store-scoped for operators), with non-disclosing failure on every cross-tenant or out-of-scope access (spec §7, SI-001–SI-009).
- **A small, safe set of review actions** — link to existing product, create new product, dismiss, and reopen — each consuming 005's lifecycle and conflict semantics without weakening them (spec §6.5–§6.7, FR-040–FR-063, FR-070).
- **Strict v1 scope discipline**: descriptive metadata is **not** surfaced (FR-021a — MUST NOT); in-scope candidate-match hints **may** be surfaced (FR-080 — display decision is MAY, but the in-scope-sourcing / no-auto-link / no-pre-select / no-leakage safety boundaries are MUST when the hint is rendered); bulk dismiss is capped at **200 items per submission** (FR-070 — MUST); reopen is restricted to **tenant-wide actors only** (FR-062a — MUST).
- **Audit completeness**: every review action (success or failure) emits through 005's existing audit pipe (FR-110–FR-113).

The plan's job is to (a) confirm the spec is consumable, (b) confirm 005 readiness, (c) document the obligations the downstream API + UI features will have to honor, and (d) explicitly defer all implementation to those downstream features. No code lands from this plan.

---

## 2. Technical Context

### 2.1 Stack inheritance — no new decisions

006 introduces **no new dependencies, runtimes, services, or storage**. The stack remains as inherited from 001 / 002 / 003 / 005 (per [CLAUDE.md](../../CLAUDE.md) Stack section).

| Concern | Inherited decision | 006's interaction |
|---|---|---|
| Database | PostgreSQL 16+ with RLS | 006 reads from `unknown_items`, `tenant_products`, `product_aliases` (all 003-owned) via 005's reconciliation surface. **006 introduces no new tables, columns, indexes, or constraints.** |
| ORM | Drizzle ORM | Consumed transitively via 005's service layer once it lands. 006 does not add schema modules. |
| Migrations | Explicit SQL files | **006 introduces no migrations.** |
| API framework | NestJS 11 | The eventual queue / inspection / action endpoints will be defined in a **separate future API feature**, not in this plan. |
| Validation | Zod 3.x with `.strict()` | Consumed in that future API feature; 006 only pins the user-visible failure categories (FR-100) that the contract must encode. |
| ID strategy | UUIDv7 (v4 fallback) | Unknown-item references, product references, audit correlation IDs all inherited unchanged. |
| Idempotency | 002's request-level token + 001's idempotency interceptor | The future API feature MAY apply idempotency tokens to write actions (link / create / dismiss / reopen / bulk-dismiss) for client-retry safety; 006 itself takes no position. |
| Audit | 005's existing audit pipe (per 005 FR-080–FR-083 / Constitution §XIII) | FR-110–FR-113 commit 006 to riding this pipe with no parallel surface. |
| Observability signals | Pre-named in 003 §9 + the `idempotency_token_mismatch_total` 005 introduces | 006 introduces **no new metric names**; review-queue actions emit through 005's `unknown_item_resolved_total{action="linked"\|"created"\|"dismissed"}` and related counters. |
| Auth principals | 001 (tenant admin / store operator), 002 (POS device — N/A here), 005 (reopen authority) | 006 introduces **no new role, permission, or membership shape**. FR-062a's tenant-wide-only reopen consumes the existing membership model. |
| UI | Dashboard frontend (separate future feature) | 006 explicitly **forbids** UI implementation (spec §0, §3); the eventual UI is routed through Impeccable (spec §11). |

### 2.2 Inputs from the spec

- **10 prioritized user stories** (spec §5; 6× P1, 4× P2) — independently testable.
- **38 functional requirements** across 11 clusters (spec §6): visibility (FR-001..005), lifecycle surfacing (FR-010..012), minimum safe info (FR-020..022 + FR-021a), filtering / empty / loading / stale (FR-030..036), link (FR-040..043), create (FR-050..052), dismiss / reopen / bulk (FR-060..073 + FR-062a), duplicate / conflict (FR-080..083), permission-aware outcomes (FR-090..092), failure categories (FR-100..102), audit (FR-110..113).
- **9 security / isolation requirements** (spec §7, SI-001..009).
- **8 measurable success criteria** (spec §8, SC-001..008).
- **12+ edge cases** (spec §5 "Edge Cases").
- **4 resolved clarifications** (spec `## Clarifications` session 2026-05-23): bulk-dismiss ceiling = 200, reopen authority = tenant-wide-only, terminal-item detail surface, v1 advisory scope.

### 2.3 NEEDS CLARIFICATION

**None.** The four material ambiguities were resolved in the spec via `/speckit-clarify`. The two remaining UI-level questions (exact pagination thresholds, queue listing latency targets) are intentionally deferred to Impeccable (spec §11, §12) and to the future UI feature; they do not block this plan.

### 2.4 Performance Goals

Not specified at 006's product level. The queue listing / inspection / action endpoints' latency budgets will be set in the future API feature (alongside Constitution §VII observability gates). Inline POS capture latency (`p95 ≤ 500 ms, p99 ≤ 1 s`) is 005's concern and is unchanged.

### 2.5 Constraints

- **Strict product-level discipline** — no UI, no API, no schema, no contracts, no services (spec §0).
- **No parallel audit / observability surface** (FR-112).
- **No parallel authority model** (SI-003, FR-092).
- **All reconciliation actions consume 005 §6.5 / §6.7** — 006 does not introduce a "force-link" or "override-conflict" path (SI-005).

### 2.6 Scale / Scope

- **Bulk dismiss**: 200 items / submission ceiling (FR-070).
- **Queue size**: unbounded per tenant; pagination strategy deferred to the future API + UI features. SC-007's "your scope is currently empty" empty state must remain non-disclosing under any pagination scheme.
- **Concurrent reviewers**: race semantics inherited from 005 US3 #3 — exactly one winner, the other receives `already-reconciled`.

---

## 3. Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design (§3.2).*

Constitution v3.0.1 ([../../.specify/memory/constitution.md](../../.specify/memory/constitution.md)).

### 3.1 Initial gate evaluation

| Principle | 006 touchpoint | Verdict |
|---|---|---|
| **I. Reference, Not Source of Truth** | 006 introduces no parallel source of catalog truth; the queue is a projection over 005's `unknown_items` and 003's `tenant_products` / `product_aliases`. | Pass |
| **II. Multi-Tenant SaaS by Default** | All visibility / actions consume 005 + 003 RLS unchanged (SI-001..009, FR-001..005). Cross-tenant access is non-disclosing not-found (FR-090, SI-004). Workers not exempt N/A — 006 introduces no worker. | Pass |
| **III. Backend Authority & Data Integrity (NON-NEGOTIABLE)** | All authority is server-side per 005 / 001 (FR-090..092). The product-level spec does **not** introduce client-trusted IDs; the future API feature must encode the canonical error envelope (Constitution §III) for FR-100's failure categories. | Pass with delegation noted |
| **IV. Contract-First POS Integration** | 006 introduces no POS-facing contract. The queue is dashboard-facing; its contract will land in a separate future API feature under `packages/contracts/openapi/` (gated). 006 only pins the **contract obligations** (request / response shape, failure category vocabulary, non-disclosing semantics) — see [contracts/README.md](./contracts/README.md). | Pass (with deferral noted in §9) |
| **V. Async Work Belongs in Workers** | All review actions are synchronous from the reviewer's perspective. Audit emission rides 005's existing audit-fanout queue. No new worker. | Pass |
| **VI. Test-First Quality** | The future API feature will be RED-then-GREEN per 003 / 005's pattern. 006 itself produces no code, but the spec's acceptance scenarios (Given/When/Then throughout §5) and isolation-harness extension obligations ([research.md §R3](./research.md)) provide the test seeds. | Pass |
| **VII. Observable Systems** | 006 introduces no new metric names (Technical Context §2.1). Review-queue actions emit through 005's existing names (`unknown_item_resolved_total{action}`, `duplicate_alias_conflict_total`, etc.). | Pass |
| **VIII. Reproducible & Versioned Releases (`[GATED]`)** | 006 itself touches **no `[GATED]` paths** — no `package.json`, no `pnpm-lock.yaml`, no SQL migrations, no `packages/contracts/openapi/**`, no `.github/**`. The future API feature will require `[GATED]` approval on its own slice; that gate is not consumed here. | Pass |
| **IX. Source-of-Truth Model** | 006 surfaces 005's lifecycle states (`pending`, `resolved`, `dismissed`) verbatim (FR-010). No fourth state introduced (FR-011). No alias / product creation by the queue itself — only by explicit human reconciliation routed through 005 (SI-006). | Pass |
| **X. Retail Temporal Semantics** | Reopen is modeled as fresh-`pending`-record creation per 005 FR-005, not lifecycle reversal (FR-061). No prior records are rewritten. Terminal-item detail surface (FR-001a) shows historical detail without mutation. | Pass |
| **XI. Idempotency & External IDs** | The future API feature MAY apply 001's idempotency token primitive to review-action writes; 006 takes no position. The product-level race semantic (`already-reconciled`, FR-100) is consumed from 005 US3 #3. | Pass with delegation noted |
| **XII. Authorization & Object Safety** | Default deny per 005 / 001. Mass-assignment N/A at the product spec level — the future API feature must enforce. Non-disclosing 404 for cross-tenant lookups (SI-004, FR-090). FR-062a tightens reopen authority to tenant-wide actors only, consuming the existing membership model. | Pass |
| **XIII. Auditability & Provenance** | Every state transition is audited via 005's existing pipe (FR-110–FR-113). No parallel surface (FR-112). The `forbidden` failure category 006 introduces (FR-100, post-review-revision 2026-05-24) and the static-state-mismatch variant of `already-reconciled` (also FR-100) are user-facing rejection variants — they must emit through 005 FR-082's failed-attempt audit path. | Pass |
| **XIV. PII & Data Lifecycle Discipline** | Identifier values remain catalog reference data (not PII). v1 explicitly **does not surface** descriptive metadata from `unknown_items.sale_context jsonb` (FR-021a) — this strengthens the redaction posture rather than weakening it. No new redaction surface. | Pass |

**Initial gate verdict**: All 14 principles pass; no violations to justify in Complexity Tracking (§11).

### 3.2 Post-design re-check

After writing Phase 1 outputs ([data-model.md](./data-model.md), [contracts/README.md](./contracts/README.md), [quickstart.md](./quickstart.md)) and applying the 2026-05-24 external-review revisions to the spec:

| Principle | Phase 1 obligation introduced | Re-check verdict |
|---|---|---|
| **III. Backend Authority** | `contracts/README.md §2.3` pins the closed `error.code` set (revised 8 categories: 005 FR-091's seven + `forbidden`; `already-terminal` collapsed into `already-reconciled` with `details.prior_state`). The future API feature's contract must encode this exact set. | Pass — set is additive vs Constitution §III's envelope; `forbidden` use is constitutionally sanctioned per §II / §XII. |
| **IV. Contract-First** | `contracts/README.md §3` forbids "force-link" / "override-conflict" / `sale_context` fields / parallel lifecycle states; obligates conformance tests. The future API feature's contract slice consumes this checklist. | Pass — 006 still authors no YAML; obligations are testable on the future API feature's slice. |
| **VI. Test-First** | `research.md §R3` enumerates three harness extensions (isolation, audit-query, contract) the future API feature must add before service code lands. Spec §5 acceptance scenarios are the seed material. | Pass — RED-then-GREEN seed identified; no code seeded by 006 itself. |
| **VII. Observable** | `data-model.md §5` confirms 006 introduces no new audit subjects beyond 005's anticipated set. The optional reopen-specific subject is the future API feature's call. | Pass — observability surface unchanged. |
| **IX. Source-of-Truth** | `data-model.md §1` confirms 006 introduces no schema; queue is a projection over 005 + 003 entities. `quickstart.md` Scenarios 1–5 all use existing 005 lifecycle transitions. | Pass — no parallel source of catalog truth. |
| **XII. Object Safety** | `contracts/README.md §2.1` enumerates the mass-assignment-forbidden field list (`tenant_id`, `store_id`, `lifecycle_state`, audit fields, etc.). FR-062a + `forbidden` category formalise the in-scope authority case. | Pass — the future API feature's controllers will be bound by this list. |
| **XIII. Auditability** | `contracts/README.md §2.4` re-pins audit emission obligations against the existing 005 pipe (no parallel channel). The revised category set still emits via 005 FR-082's failed-attempt path. | Pass — audit posture unchanged. |
| **XIV. PII Discipline** | `data-model.md §1` + `contracts/README.md §2.7` lock the prohibition on surfacing `unknown_items.sale_context jsonb` fields in v1 — conformance test 6 in §4 verifies this. | Pass — posture strengthened, not weakened. |

**Post-design verdict**: No deltas from §3.1's initial Pass verdicts. All Phase 1 obligations and the 2026-05-24 revisions land within the constitutional envelope. Architecture Impact (§4) remains **Low**. No Complexity Tracking entries needed.

---

## 4. Architecture Impact Map

Per Working Agreement appendix and [`.specify/memory/architecture-impact.md`](../../.specify/memory/architecture-impact.md).

### 4.1 Impact Classification

- **Impact level**: **Low**
- **Reason**: 006 is a product-level specification with no source-code, schema, contract, runtime, deployment, dependency, observability, or auth-surface change in **this repository**. The eventual API and UI features that consume 006 will each carry their own Architecture Impact Maps when they are specified.
- **Boundary crossings**: none from 006 itself. Documented for completeness:
  - **API → Worker**: none.
  - **API → DB**: none.
  - **Worker → DB**: none.
  - **Package boundary**: none — 006 lives entirely under `specs/006-unknown-items-review-queue/`.
  - **External provider**: none.
  - **OpenAPI / codegen**: none in this plan. The future API feature will introduce dashboard-facing operationIDs (see [contracts/README.md](./contracts/README.md) for the anticipated obligations the future contract must honor).
  - **Runtime / deployment**: none.

### 4.2 Triggered Review Gates

- [ ] **DB read/write → RLS / tenant-context strategy required.** _Not triggered by 006 itself._ Triggered by the future API feature, which will read 005's `unknown_items` and 003's `tenant_products` / `product_aliases` under existing RLS.
- [ ] **OpenAPI / API contract change → contract validation and codegen impact required.** _Not triggered by 006 itself._ Triggered by the future API feature, which will add dashboard-facing operationIDs under `packages/contracts/openapi/` on a `[GATED]` slice.
- [ ] **Queue / job publish or consume → producer / consumer contract tests required.** _Not triggered by 006 itself._ The future API feature will produce audit events via 005's existing pipe — no new producer / consumer.
- [ ] **Auth / session / token change → threat review required.** _Not triggered._ 006 introduces no new principal, role, or token shape.
- [ ] **Package dependency change → explicit approval required.** _Not triggered._
- [ ] **Cross-package or cross-app import → boundary justification required.** _Not triggered._
- [ ] **External provider integration → verification, outage, failure-mode plan required.** _Not triggered._

### 4.3 Required dimensions

| Dimension | Impact from 006 |
|---|---|
| Affected modules / packages | **None in this plan.** 006 lives entirely under `specs/006-unknown-items-review-queue/`. |
| DB tables read | None from 006. (Future API feature: `unknown_items`, `tenant_products`, `product_aliases`, `memberships`, `stores`, `tenants` — all existing.) |
| DB tables written | None from 006. (Future API feature: same write surface 005 already defines — `unknown_items` lifecycle, `product_aliases` insert / reactivate, `tenant_products` insert on create-new, `audit_events` / `outbox_events` via interceptor.) |
| APIs / OpenAPI contracts changed | **None in this plan.** Future API feature anticipated operationIDs: `tenantAdminListUnknownItems`, `tenantAdminGetUnknownItem`, `tenantAdminLinkUnknownItem`, `tenantAdminCreateProductFromUnknownItem`, `tenantAdminDismissUnknownItem`, `tenantAdminBulkDismissUnknownItems`, `tenantAdminReopenUnknownItem`, `tenantAdminListResolvedUnknownItems`, `tenantAdminListDismissedUnknownItems`. Exact YAML paths and operationIDs will be decided on the future API feature's contract slice. |
| Events / jobs published | None from 006. (Future API feature will reuse 005's audit subjects; see 005 plan §3.3.) |
| Events / jobs consumed | None. |
| Files likely to require edits | None from 006 outside `specs/006-unknown-items-review-queue/`. |
| Risky dependencies / boundary concerns | The only "risk" 006 surfaces is the **dependency chain**: 006's downstream features cannot ship until 005 Wave 2 (reconciliation) lands. See §5. |
| Regression test areas | None impacted by 006 itself. The future API feature will extend the existing isolation harness (003 T340 pattern, 005's extensions). 006's spec acceptance scenarios are the seed material for those extensions. |

### 4.4 New observability signals introduced by 006

**None.** Per FR-110–FR-113 the review queue rides 005's existing audit and metric surface.

The user-facing `forbidden` failure category 006 introduces (FR-100, post-review-revision 2026-05-24) and the static-state-mismatch variant of `already-reconciled` (also FR-100) are new at the **product-level vocabulary**, but they emit through 005 FR-082's existing failed-attempt audit subjects (one of `unknown_item.reconciliation_conflict_rejected` or a sibling), not as new metrics. If the future API feature determines either rejection class warrants a distinct metric name, that decision lands there with its own Architecture Impact entry.

---

## 5. 005 Dependency Readiness

006 is **strictly downstream of 005**. Its product-level guarantees cannot be implemented until 005's reconciliation surface is live. This section documents what 005 has shipped, what is mid-flight, and what remains the implementability gate for 006's downstream features.

### 5.1 005 — what is on `main`

As of `origin/main` at `2bf7e27` (top of `git log` at the time this plan was authored — captures the 003 PHASE3_RED_WAVE T350 + T360 contract-spec landing in PR #300):

| Component | Status | What it provides 006 |
|---|---|---|
| **005 spec** (clarified, revised 2026-05-23) | merged on `main` via PR #293 (`9d835eb`) | Authoritative workflow semantics 006 consumes verbatim (lifecycle, idempotency, conflict, audit). |
| **005 execution-map.yaml + wave-status.md** | merged via PR #298 (`dd38594`) | Slice state visibility for 006's planning. |
| **005 Wave 1 metrics allowlist** (PR #299, `28d1a0d`) | merged | The 005-introduced metric `idempotency_token_mismatch_total` is allowlisted for the operator `/metrics` scrape. 006 emits **no new metric** and therefore does not require a further allowlist amendment. |
| **005 catalog module skeleton + Wave 1 metric registration** (PR #304, `622e509`) | merged | Module wiring exists; capture-path service code is being added slice-by-slice. |
| **005 Wave 1 closeout docs** (PR #305, `3fe32b1`) | merged | Status snapshot through Wave 1 setup. |
| **003 T350 + T360 catalog-service contract specs** (PR #300, `2bf7e27`) | merged | Tenant + global catalog service RED specs and initial service files; the T350 path is now closer to GREEN than 005's plan snapshot reflected. |

**Net**: 005 Wave 1 (capture path) is **in progress on `main`** with the module skeleton, metric registration, and metric allowlist all merged. Capture-path service code lands slice-by-slice under the 005 wave plan.

### 5.2 005 — Wave 1 (capture) remaining work — does not gate 006 *planning*

Wave 1 covers POS submission → unknown-item capture → idempotency → audit emission. 006's queue *reads* unknown items captured by Wave 1, but 006's **plan** can be authored before Wave 1 fully ships because:

- 006's spec defines product-level UX over a closed-set state machine (`pending` / `resolved` / `dismissed`) that 005 has already locked in its merged spec.
- 006 introduces no schema, contract, or code that depends on Wave 1's service surface.
- The future API feature (which *does* read `unknown_items`) will plan against Wave 1's then-current state.

### 5.3 005 — Wave 2 (reconciliation) — the actual 006 *implementation* gate

006's link / create / dismiss / reopen actions consume 005's reconciliation service surface, which 005 plan §8.2 schedules as **Wave 2**. As of `origin/main` at `bbb9beb`, the **003 PHASE3_RED_WAVE prerequisites for Wave 2 are now all merged** (closed out by PR #309); Wave 2 itself remains unscheduled (its slices have not yet been authored).

| 005 Wave 2 prerequisite | Status | What 006 needs from it |
|---|---|---|
| `T350_TENANT_CATALOG_CREATE_RED` (003) → `TenantCatalogService.create()` | **merged** via PR #300 (`2bf7e27`) — RED contract spec + initial service file landed. Subsequent GREEN slices (validation, full coverage) lie outside 005 plan §4.2's named set and are not yet on `main`. | Backs the eventual `tenantAdminCreateProductFromUnknownItem` flow (006 FR-050). |
| `T360_GLOBAL_CATALOG_LIST_RED` (003) → `GlobalCatalogService.list()` | **merged** via PR #301 (`f577570`) — RED contract spec + initial service file landed. | Not directly consumed by 006; noted for catalog-wave context. |
| `T372_STORE_OVERRIDE_CREATE_RED` (003) → `StoreOverrideService.create()` | **merged** via PR #302 (`c4147b0`) — RED contract spec landed. | Not directly consumed by 006. |
| `T383_PRODUCT_ALIASES_UNIQUENESS_RED` (003) → `ProductAliasesService` with uniqueness rules | **merged** via PR #303 (`454a7ae`) — RED contract spec for alias uniqueness landed. | Backs every 006 reconciliation action that writes an alias (FR-040..043, FR-050..052, FR-060..063 indirectly via 005). **This was the canonical PHASE3_RED_WAVE blocker referenced in 005 plan §4.2.** |
| PHASE3_RED_WAVE closeout | **closed out** via PR #309 (`bbb9beb`) — confirms all four RED contract specs above are on `main`. | Removes the headline blocker on 005 Wave 2's scheduling. |
| 005 reconciliation service modules (Wave 2 GREEN slices) | not yet specced as slices | Backs the queue's `link`, `create`, `dismiss`, `reopen` actions end-to-end. |

**Net**: 006's **downstream API + UI features cannot ship** until 005 Wave 2 is on `main`. The expected serial chain is:

```text
003 PHASE3_RED_WAVE  →  005 Wave 1 (capture)  →  005 Wave 2 (reconciliation)
                                              →  006 future API feature  →  006 future UI feature
```

### 5.4 What this means for the 006 spec PR

This planning artifact (and the 006 spec PR more broadly) is **safe to land now**:

- 006 introduces no code that depends on 005 Wave 2.
- 006's product-level guarantees cite 005's already-merged spec semantics, not its in-flight code.
- The downstream features will read 006's spec as their product brief; they will gate their own implementability on 005 Wave 2 at planning time.

If 005's lifecycle, conflict, idempotency, or audit semantics shift before Wave 2 ships, 006's spec will need a clarify pass to re-align — but that is a known risk surface, not a current blocker.

---

## 6. Project Structure

### 6.1 Documentation (this feature)

```text
specs/006-unknown-items-review-queue/
├── spec.md                 # Product spec (drafted + clarified)
├── plan.md                 # This file (/speckit-plan command output)
├── research.md             # Phase 0 output — 005 readiness, Impeccable integration, test harness obligations
├── data-model.md           # Phase 1 output — pointer doc: 006 consumes 005 / 003 entities verbatim
├── quickstart.md           # Phase 1 output — stakeholder walkthrough of a clear-the-queue session
├── contracts/
│   └── README.md           # Phase 1 output — contract obligations the future API feature must honor; no YAML in 006
└── checklists/
    └── requirements.md     # Spec-quality checklist (created by /speckit-specify, all green)
```

`tasks.md` is **not** produced by this plan. See §9.5.

### 6.2 Source code (repository root) — none

006 adds no files outside `specs/006-unknown-items-review-queue/`. Every other directory in the repo is **untouched** by this feature.

**Structure decision**: documentation-only feature. No source-code structure decisions apply.

---

## 7. Phase 0 outputs

[research.md](./research.md) consolidates findings for the four research topics 006 surfaces:

- **R1 — 005 Wave 1 / Wave 2 readiness**: confirms 005's merged status, identifies the 005 Wave 2 path 006's downstream features will consume.
- **R2 — Impeccable workflow integration**: confirms the routing rule in spec §11, identifies what artifacts the eventual /impeccable shape brief will need from 006.
- **R3 — Test harness extension obligations**: enumerates the isolation harness (003 T340 pattern), audit-query, and acceptance-scenario test surfaces the future API feature will need to extend in order to validate 006's product-level guarantees.
- **R4 — Failure category vocabulary**: confirms 005 FR-091 + the `forbidden` extension 006 introduces (FR-100, post-review-revision 2026-05-24) is consistent with Constitution §III's canonical error envelope; identifies where the future API feature must encode it.

**Output**: [research.md](./research.md) with all four research items resolved as Decision / Rationale / Alternatives.

---

## 8. Phase 1 outputs

### 8.1 Data model

[data-model.md](./data-model.md) — **pointer document only**. 006 introduces no entities; it cites 005 / 003's existing entities (`unknown_items`, `tenant_products`, `product_aliases`, `audit_events`) and the user-visible projection obligations the eventual API + UI features must produce from them (FR-001a, FR-020..022 + FR-021a).

### 8.2 Quickstart

[quickstart.md](./quickstart.md) — a stakeholder-readable walkthrough of one tenant-admin "clear the queue" session, cross-referenced back to spec §5 user stories. Used as input to the eventual `/impeccable shape` brief (spec §11) and as a non-technical validation surface for the spec.

### 8.3 Contracts

[contracts/README.md](./contracts/README.md) — **no YAML**. The file enumerates the contract obligations (queue list, item inspection, link, create, dismiss, reopen, bulk dismiss with 200-item ceiling, listing terminal items) and the failure category vocabulary (FR-100) the eventual dashboard-facing API contract under `packages/contracts/openapi/` must encode. Actual contract authoring is a `[GATED]` slice in the future API feature.

### 8.4 Agent context update

CLAUDE.md does not currently use `<!-- SPECKIT START --> / <!-- SPECKIT END -->` markers (per repo convention; the "Active feature" section is hand-curated). The agent-context update step is therefore a **no-op for 006** — 006 is a downstream brief, not an active in-flight implementation. When the future API feature is opened, CLAUDE.md will be updated to point its "Active feature" section at that downstream work; 006 itself remains a reference brief that downstream specs cite.

---

## 9. Implementation Phasing (advisory — `/speckit-tasks` may not be required)

This is the single most important phasing decision in this plan: **006 itself produces no implementation slices.** Implementation happens in two follow-up feature specs, neither of which is in scope here.

### 9.1 Future API feature (separate spec, separate branch, separate PR)

Not scheduled by this plan. When opened, that feature will:

- Carry its own spec / clarify / plan / tasks artifacts.
- Define the dashboard-facing OpenAPI contracts under `packages/contracts/openapi/` (`[GATED]`).
- Define the NestJS controllers + services under `apps/api/src/catalog/...` (TBD on the future feature's plan).
- Extend the existing isolation harness (003 T340 pattern, 005's extensions) for the queue surface — see [research.md §R3](./research.md).
- Gate its implementability on 005 Wave 2 (per §5.3).

### 9.2 Future UI feature (separate spec, separate branch, separate PR)

Not scheduled by this plan. When opened, that feature will:

- Be routed through Impeccable **before** any UI code lands: `/impeccable shape` → `/impeccable critique` → `/impeccable audit` → `/impeccable polish` → `/impeccable clarify` (spec §11).
- Consume the API contracts from the future API feature.
- Carry its own spec / clarify / plan / tasks artifacts.

### 9.3 What this plan does NOT schedule

- No API endpoint design.
- No OpenAPI YAML.
- No NestJS services / controllers / DTOs / guards.
- No schema migrations.
- No worker changes.
- No React components, routes, pages, modals, CSS, design tokens.
- No Impeccable rounds (they fire in the future UI feature).
- No CI / package / lockfile changes.

### 9.4 Gated paths touched by **this plan**

**None.** The 006 spec PR and this plan touch only `specs/006-unknown-items-review-queue/` files — no `package.json`, no `pnpm-lock.yaml`, no SQL migrations, no `packages/contracts/openapi/**`, no `.github/**`.

### 9.5 `/speckit-tasks` for 006 — likely not required

Because 006 schedules no implementation, `/speckit-tasks` against 006 would produce either (a) zero tasks or (b) administrative tasks (cross-link to downstream features, update CLAUDE.md when downstream features open). The plan owner MAY skip `/speckit-tasks` for 006 entirely, or MAY run it to generate a minimal **dependency-tracking** tasks.md (e.g., "Confirm 005 Wave 2 readiness before opening the future API feature spec"). Both are acceptable; the decision is operational, not architectural.

---

## 10. Out of Scope (Reaffirmed from spec §3)

- Dashboard UI implementation of any kind.
- React components, routes, pages, tables, modals, CSS, layout, design tokens.
- API endpoint design or OpenAPI contracts.
- POS client behavior or SDK changes.
- Database schema changes, migrations, RLS amendments.
- NestJS modules, services, controllers, workers, guards, interceptors, repositories.
- Catalog foundation (003), POS identity (002), platform readiness (004), reconciliation backend (005) — consumed unchanged.
- Analytics, dbt, ClickHouse, Dagster, reports, billing, observability dashboards.
- `tasks.md` from this plan (see §9.5).

If any of the above appear necessary while implementing a future the future API feature / the future UI feature feature, that need lands in **that** feature's spec — not by amending 006.

---

## 11. Complexity Tracking

> No Constitution Check violations. Table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _(none)_  | _(N/A)_    | _(N/A)_                              |

---

## Appendix — Files inspected during planning

- [spec.md](./spec.md) (full read, including post-clarify state)
- [checklists/requirements.md](./checklists/requirements.md)
- [../005-pos-catalog-sync-reconciliation/spec.md](../005-pos-catalog-sync-reconciliation/spec.md) (§1–§10 + Clarifications)
- [../005-pos-catalog-sync-reconciliation/plan.md](../005-pos-catalog-sync-reconciliation/plan.md) (structure + Constitution Check + Architecture Impact + 003 dependency readiness pattern)
- [../../.specify/memory/constitution.md](../../.specify/memory/constitution.md) (Principles I–XIV, Working Agreement appendix)
- [../../CLAUDE.md](../../CLAUDE.md) (Agent OS bootstrap order, Active feature, Specs summary)
- [../../docs/agent-os/standing-rules.md](../../docs/agent-os/standing-rules.md) (forbidden paths, gated approvals, stop conditions)
- Recent `git log` (top 5 commits) — confirms 005 Wave 1 progression
