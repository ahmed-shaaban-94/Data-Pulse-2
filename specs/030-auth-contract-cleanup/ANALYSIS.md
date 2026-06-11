# Analysis — Draft D4 DP-2 Auth Contract Cleanup (Role-Named Security Schemes, additive)

> **DRAFT — NOT DISPATCHED.** Readiness analysis artifact under the docs-only Orchestrator. This file performs the per-spec speckit-analyze readiness pass (internal spec<->plan<->tasks consistency + requirement->task coverage). It implements nothing, edits no contract, mutates no gate or kernel node, and authorizes no dispatch. Dispatch remains **gated: G10 verification + scoped owner approval**.

**Status:** SPECIFY-ONLY / DRAFT — for owner review.  **Analysis date:** 2026-06-12.  **Owning repo:** Data-Pulse-2.
**Spec:** [./spec.md](./spec.md)  ·  **Plan:** [./plan.md](./plan.md)  ·  **Tasks:** [./tasks.md](./tasks.md)  ·  **Requirements checklist:** [./checklists/requirements.md](./checklists/requirements.md)
**Analysis branch:** `docs/028-followups-analyze` (off `origin/main`; spec already merged to `origin/main`).
**Tooling path:** Manual fallback. `.specify/feature.json` on this branch points to `specs/018-connector-boundary-hardening`, not this spec, and the spec was authored manually outside `.specify` tooling (spec authoring notes). Running `/speckit-analyze` would target the wrong feature dir and risk writing outside the two allowed artifacts, so the identical analysis was performed manually. **No existing spec/plan/tasks file was edited; only this file and `checklists/analyze-readiness.md` were added.**

---

## 0. Scope of this pass

This is the **internal-consistency** readiness pass (finer than the cross-repo collision report already done): every functional goal (G-*) and acceptance criterion (A-*) traced to >=1 task; plan phases cover all spec sections; no contradiction / duplication; gates correctly tagged (G10 + G2, no G3). Evidence anchors (E-1...E-6) were re-verified against `origin/main` so coverage is asserted against the repo, not against the spec's own self-claims.

## 1. Evidence re-verification (independent, `origin/main`, this session)

Confirmed against `git show origin/main:<file>` — the spec's evidence is accurate, not merely asserted:

| Spec claim | Independent finding on `origin/main` | Verdict |
|---|---|---|
| E-1: `clerkJwt` string appears in **16** contract files | `git ls-tree -r` + per-file grep -> exactly **16** files contain the string | **CONFIRMED** |
| E-1/E-6: active operation-level `- clerkJwt: []` on **7 POS contracts only** | Active refs: read-down=2, unknown-items=1, pos-audit-events=1, pos-operators=5, pos-payments/vouchers=4, pos-sales/sales=4, pos-shifts=1 -> **7 files, all POS** | **CONFIRMED (counts match section 4 table exactly)** |
| E-6: connector/erpnext `clerkJwt` mentions are prose disclaimers, not active refs | connector-admin / reconciliation / console-sync-ops / posting-feed / stock-view contain the string but **0** active `- clerkJwt: []` refs | **CONFIRMED** |
| E-6: connector/erpnext already role-named | `cookieAuth: []` active on connector-admin / reconciliation / console-sync-ops; `connectorBearer: []` active on posting-feed / stock-view | **CONFIRMED** |
| E-2: read-down is an opaque device token under a Clerk-named scheme, with in-file deferred-rename note | read-down.yaml: `bearerFormat: JWT` intentionally omitted; comment "Renaming the scheme key POS-wide to something like `posDeviceAuth` is a separate cross-contract decision..."; `Authorization: Bearer <device_token> — an opaque token (NOT a JWT)` | **CONFIRMED (the canonical mislabel)** |
| E-3: sale-sync is a genuine Clerk JWT + `X-Device-Attestation` (Option-Y) | sales.yaml: `clerkJwt` = `scheme: bearer`, `bearerFormat: JWT`; `X-Device-Attestation` header present; 4 active refs | **CONFIRMED** |
| E-4: sign-in is a genuine provider-identity JWT | pos-operators.openapi.yaml: 5 active `- clerkJwt: []` refs; "Verifies the Clerk JWT ... operator identity"; framed as identity proof | **CONFIRMED** |

> Note: an initial `git grep -l` with a `/**/*.yaml` pathspec under-listed the root-level `*.openapi.yaml` files; recounting with `git ls-tree -r` + per-file grep reproduced the spec's numbers exactly. The discrepancy was a glob artifact, not a spec error. **No evidence defect found.**

Constitution alignment (`.specify/memory/constitution.md`, Principle IV — Contract-First POS Integration, stable `operationId`, `packages/contracts/openapi/` as source of truth): the additive-rename approach renames `securitySchemes` keys and `security:` references only, preserving `operationId`s and the contract-first source-of-truth posture. **Aligned.**

## 2. Requirement -> task coverage matrix

### 2.1 Goals (G-1 ... G-8)

| Goal | Intent | Covering task(s) / plan phase | Acceptance link | Covered? |
|---|---|---|---|---|
| **G-1** Introduce role-named schemes (role, not provider) | T4 (`device`), T6 (`operator-identity`); Plan Phase 1 | A-1 | **YES** |
| **G-2** Retire misleading `clerkJwt` where credential != Clerk operator JWT | T9 (retire from fully-migrated); T4/T5/T6 (re-point); Plan Phase 3 | A-2 | **YES** |
| **G-3** read-down + device surfaces document `device` (opaque, no `bearerFormat: JWT`) | T4 (read-down), T5 (other device surfaces); Plan Phase 2 | A-3 | **YES** |
| **G-4** sign-in documents `operator-identity` as identity proof, not authz, not conflated with sale-sync envelope | T6; Plan Phase 1/2 | A-4 | **YES** |
| **G-5** confirm connector/service already role-named; no rename | T8 (negative-confirmation); Plan Phase 0/1 | A-5 | **YES** |
| **G-6** purely additive + doc<->runtime-honest (new name matches verified runtime) | T2 (per-op runtime trace), T3 (classify; ambiguity=>DEFER); Plan Phase 0; tripwires | A-6 | **YES** |
| **G-7** explicitly defer sale-sync rename to D1; document Option-Y in interim | T7 (hold + handoff note), T12 (residual handoff); Plan Phase 2/4 | A-7 | **YES** |
| **G-8** scope non-interchangeability visible as distinct named schemes (028 SR-10) | T4 + T6 (two distinct schemes) + T8 (connector schemes remain distinct) | A-9 | **YES** |

**All 8 goals covered. No uncovered goal.**

### 2.2 Acceptance criteria (A-1 ... A-10)

| Criterion | Covering task(s) | Covered? | Note |
|---|---|---|---|
| **A-1** role-named schemes defined, role-descriptive keys | T4, T6 | **YES** | |
| **A-2** `clerkJwt` retired on in-scope non-operator surfaces | T9 (+T4/T5/T6 re-point) | **YES** | |
| **A-3** read-down/device = `device` scheme, opaque, no `bearerFormat: JWT` | T4, T5 | **YES** | |
| **A-4** sign-in = `operator-identity`, identity proof not authz | T6 | **YES** | |
| **A-5** connector/service confirmed already role-named, out of active set | T8 | **YES** | negative-confirmation task |
| **A-6** every renamed surface matches runtime verified **today** | T2, T3 (+ T10 doc<->runtime audit) | **YES** | the additive guarantee |
| **A-7** sale-sync rename excluded + deferred to D1, Option-Y documented | T7 (+ T11 negative test) | **YES** | |
| **A-8** contract-only; no migration/guard/token change; gates G10+G2, not G3 | T11 (no-migration negative test); gate legend on every task | **YES** | |
| **A-9** scope non-interchangeability visible as distinct schemes | T4 + T6 (+ T8) | **YES** | |
| **A-10** no implementation/contract/migration authored; nothing claimed present on `origin/main` | **Satisfied by artifact nature** (SPECIFY/DRAFT framing; spec section 3 N-1/N-8, E-5) | **YES** | Meta/draft-level criterion — correctly NOT mapped to a post-dispatch task; it asserts the draft itself authored no implementation, which is true of this artifact set |

**All 10 acceptance criteria covered.** A-10 is a draft-level/meta criterion satisfied by the artifact's SPECIFY/DRAFT nature (not by a tasks.md entry) — this is correct, not a coverage gap.

### 2.3 Task -> requirement back-trace (every task earns its place)

| Task | Serves | Orphan? |
|---|---|---|
| T1 enumerate refs | precondition for G-6 / Phase 0 | no |
| T2 confirm per-op runtime | G-6, A-6 | no |
| T3 classify | G-6, A-6, feeds all re-points | no |
| T4 `device` + read-down | G-1, G-3, A-1, A-3 | no |
| T5 remaining device surfaces | G-3, A-3 | no |
| T6 `operator-identity` + re-point | G-1, G-4, A-1, A-4 | no |
| T7 hold sale-sync | G-7, A-7, N-2 | no |
| T8 confirm connector no-rename | G-5, A-5 | no |
| T9 retire `clerkJwt` | G-2, A-2 | no |
| T10 validate contracts | A-1/A-3 verification | no |
| T11 deferral + no-migration tests | A-7, A-8 | no |
| T12 consumer-handoff | G-7 tail / rollout (section 6); 028 section 20 | no (supporting task, no 1:1 FR — expected) |

**No orphan task. No duplicated task.** T12 has no 1:1 FR but is legitimate rollout/handoff scaffolding (spec section 6), not a duplication.

## 3. Spec <-> plan <-> tasks consistency findings

### 3.1 Structural coverage (spec sections -> plan phases -> tasks)

| Spec section | Plan coverage | Tasks coverage | Aligned? |
|---|---|---|---|
| section 4 Scope fence (in/out per-surface) | Phase 0 classification | T1-T3, T7, T8 | **YES** |
| section 5 Target contract shape (2 role schemes; service vocab-only) | Phase 1 | T4, T6 (+ T8 no-service) | **YES** |
| section 6 Migration/rollout (additive-first; consumer regen downstream; sale-sync handoff) | Phases 1-4 | T9 (additive retirement), T12 (handoff) | **YES** |
| Acceptance A-1...A-10 | Test/verification strategy | T10, T11 | **YES** |
| Dependencies (G10+G2, no G3; D1->D4 REFUTED; no D3 dep) | Gate preconditions | preconditions + per-task gate legend | **YES** |
| Non-goals N-1...N-8 | "Out of scope (this plan)"; tripwires | "Out of scope"; scope-leak tripwires | **YES** |

Gate tagging is internally consistent: every task carries `[G10]` and/or `[G2]`; **no `[G3]` anywhere**, matching A-8 / N-4 / Clarifications Q5. Tripwires in both plan and tasks explicitly stop on any proposed migration, guard edit, or sale-sync `security:` change.

### 3.2 Findings (all LOW severity — none block dispatch-readiness)

- **F-1 (LOW, doc-hygiene; in `requirements.md`, NOT this spec body).** `checklists/requirements.md` line 56 cites the old draft path `docs/specs/drafts/028-followups/d4-dp2-auth-contract-cleanup/` for "files created," but the spec now lives at `specs/030-auth-contract-cleanup/`. Stale path reference only; does not affect coverage or scope. **Recommend** the owner correct the path in `requirements.md` (not corrected here — this pass only ADDs artifacts and must not edit existing spec-set files).
- **F-2 (LOW, wording mismatch).** `tasks.md` T2 lists "service bearer" among the credential buckets to record per operation, while T3, T8, and plan Phase 0 are explicit that there is **no `-> service` bucket** (connector/erpnext are out of the classification set, E-6). The T2 bucket list is harmlessly broader than the realized classification. **Recommend** a one-line edit narrowing T2 to "device token / provider-identity JWT / sale-sync Option-Y" with a parenthetical that service surfaces are pre-confirmed out of scope. Non-blocking.
- **F-3 (LOW, looseness).** `tasks.md` T1 says "across the 16 contracts," whereas plan Phase 0 is precise ("7 POS contracts... ignore the prose-disclaimer mentions"). T1 framing is the loose one; T2/T3 immediately re-tighten to active refs, so no operation is mis-scoped. **Recommend** T1 read "enumerate the active `clerkJwt` `security:` references (7 POS contracts; the string appears in 16 files, 9 of them prose-only)." Non-blocking.
- **F-4 (LOWEST, rationale nuance — optional).** section 4 maps `sales.yaml readSale` to DEFER for a **D2** reason (phantom `pos_operator` guard, drift D2), while T7 hold-note frames the deferral rationale as the **D1** operator-authorization-envelope. Same action (hold, do not rename) and same eventual slice (the D1/D2 bundle), but the stated *reason* differs between the two surfaces folded into T7. **Recommend** T7 distinguish capture/void/refund (D1 envelope) from `readSale` (D2 phantom guard) in its note. Cosmetic; does not change behavior or scope.

No contradictions, no missing requirement->task links, no mis-tagged gates, no duplicated requirements were found beyond the four LOW items above.

## 4. Constraint / forbidden-surface self-check (this pass)

- Only two files added: `specs/030-auth-contract-cleanup/ANALYSIS.md` and `specs/030-auth-contract-cleanup/checklists/analyze-readiness.md`. **No** code, contract/OpenAPI, migration, package/lock, CI, or secret authored.
- Existing `spec.md` / `plan.md` / `tasks.md` / `requirements.md` were **read-only** — not edited.
- Sibling/owning-repo contracts read **read-only** via `git show origin/main:` for evidence; no checkout/edit of any contract.
- No commit, push, PR, or stage performed; no branch mutation beyond operating on the pre-created `docs/028-followups-analyze`.
- Artifacts remain marked **SPECIFY/DRAFT**; this pass asserts **readiness**, not dispatch authorization (G10 + owner approval still required).

## 5. Dispatch-readiness verdict

### READY — internally complete and dispatch-ready, subject to G10 verification + scoped owner approval.

Rationale:
- **Coverage complete.** All 8 goals (G-1...G-8) and all 10 acceptance criteria (A-1...A-10) trace to >=1 task (or, for the meta criterion A-10, are satisfied by the artifact draft nature). No orphan or duplicate task.
- **Spec<->plan<->tasks consistent.** Every spec section maps to a plan phase and task set; gate tagging is uniform and correct (G10 + G2, **no G3**); non-goals and tripwires are mirrored across plan and tasks.
- **Evidence verified independently** against `origin/main` (16-string / 7-active split; connectorBearer + cookieAuth on connector surfaces; read-down device-token mislabel; sale-sync Option-Y) — the additive doc<->runtime-honesty guarantee (G-6) is grounded in fact.
- **Scope fence intact.** The sale-sync rename is fenced out to D1 (T7 negative test, N-2); the connector `service` rename is correctly absent (T8 negative-confirmation); the cleanup is contract-naming only.

The four findings (F-1...F-4) are all **LOW** doc-hygiene / wording items that do not affect coverage, scope, gating, or the additive guarantee. None blocks dispatch-readiness; each is a recommended owner polish, applicable in the owning repo plan phase or as a quick correction to `requirements.md`/`tasks.md`.

**Gate reminder:** READY != dispatch-authorized. D4 is `[GATED]`. No work begins in Data-Pulse-2 until **G10 is verified for boundary decisions and the owner grants scoped D4 approval**, and the sale-sync surfaces must remain on `clerkJwt` until D1 lands.

---

> **Docs-only record (DRAFT — NOT DISPATCHED).** This analysis records readiness only. It implements nothing, edits no contract, and mutates no gate or kernel node.
