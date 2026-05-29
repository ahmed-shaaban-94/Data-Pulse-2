# Wave Status — `007-unknown-items-review-queue-api`

**Last updated:** 2026-05-29 (SIGN-OFF decisions recorded; planning chain complete)
**Spec:** [`specs/007-unknown-items-review-queue-api/`](.)
**Base:** `origin/main` at `da032d2` (PR #398, 005 fully-closed marker, 2026-05-29)
**Branch:** `spec/007-unknown-items-review-queue-api`
**Active findings:** 0
**Resolved findings:** 0

---

## TL;DR

**007 is the dashboard-facing API feature that 006 deferred** (006 plan §9.1), now implementable since 005 Waves 1+2 shipped (contract + runtime on `main`). It **extends** the already-shipped 005 unknown-items surface rather than greenfielding: the genuine delta is **inspect (GET /{id})**, **reopen**, **bulk-dismiss**, **list-param extensions**, the **`forbidden`** 8th error category, and the **`ReviewQueueItem`** projection (omits `sale_context`).

**Planning chain complete on branch (not yet on `main`):**

- `aab701d` — spec + clarify + plan + Phase 0/1 artefacts
- `45ae621` — tasks.md (Phase 2 — 39 dependency-ordered slice tasks)
- `8a97e97` — analyze remediation (3 polish tasks T074–T076 + FR traceability refs → 42 tasks)

`/speckit-analyze` (2026-05-29) found **0 CRITICAL**, spec/plan/tasks consistent. Two `[SIGN-OFF]` decision gates were the only items blocking GREEN — **both are now recorded below.**

**Next operational moves before `/speckit-implement`:**

1. ✅ Both SIGN-OFF decisions recorded (this document, § SIGN-OFF Decisions).
2. ⏳ Request `[GATED]` approval for the T010 OpenAPI extension (`packages/contracts/openapi/catalog/unknown-items.yaml` — forbidden surface).
3. ⏳ Then dispatch the RED→GREEN pairs (GATED contract slice first).

---

## SIGN-OFF Decisions

Two product decisions were deferred from `/speckit-plan` (research §R1 / §R6) into `tasks.md` as `[SIGN-OFF]` gates (T002, T003). Both are recorded here as the authoritative verdict. **These gate the dependent GREEN tasks; recording them unblocks implementation.**

### T002 — `sale_context` tightening (research §R1; gates T032 / T042)

**Verdict: TIGHTEN — option (a), tighten now.**

The shipped `tenantAdminListUnknownItems` response (and the shipped `UnknownItem` schema at `packages/contracts/openapi/catalog/unknown-items.yaml` lines 704–711; runtime `unknown-items.controller.ts:168,225`) currently returns `sale_context`. 007 FR-007 / 006 FR-021a make this a **MUST NOT** for the review surface, and the shipped list **is** the review queue. Therefore:

- The 007 GATED contract extension (T010) switches the list, inspect, and FR-001a terminal-detail responses to the **`ReviewQueueItem`** projection (= `UnknownItem` minus `sale_context`) **in this slice** — not behind a deprecation window.
- This **modifies a 005-shipped response shape.** In-scope consequences flagged for the GATED slice (T010) and its conformance work:
  - 005's contract-conformance tests for `tenantAdminListUnknownItems` MUST be updated to expect the `sale_context`-free shape (or assert it is absent).
  - Any 005-era consumer/test that asserted `sale_context` **presence** on the list response MUST be reconciled. (Search before GREEN: `grep -rn "sale_context" apps/api/test/catalog/`.)
  - The `info.version` bump on the YAML documents the response-shape change (additive elsewhere, narrowing here — call it out in the version note).
- **Rejected:** "leave `sale_context` on the shipped list" — that would ship an FR-007 violation and was only permissible under an explicit FR-007 waiver, which is **not** granted.

**Rationale:** FR-007 is a MUST NOT and the shipped list is the user-facing review queue; leaving descriptive metadata on it is a data-surface defect, not a backward-compat nicety. Tightening now (vs. a deprecation window) avoids shipping a known leak into the first review-API release. The cost — touching 005's conformance tests — is bounded and is exactly what the GATED slice exists to review.

### T003 — Idempotency-key retrofit (research §R6; gates key-replay assertions in T060–T062)

**Verdict: ISOLATE — option (b), do not retrofit shipped ops in v1.**

- The **new** state-changing operations (reopen — T053/T054; bulk-dismiss — T057/T058) carry the `Idempotency-Key` header and provide **identical-replay-response** (replay same key+body → prior response; changed body → `idempotency_key_conflict` / 409).
- The **shipped** link / create / dismiss operations keep their existing **monotonic-guard no-duplicate-effect** (a retry of an already-applied action returns `already-reconciled`, never a second effect). They are **not** retrofitted with an idempotency key in v1.
- Consequence for tasks: the "If T003 = (a), add key-replay assertions" clauses in **T060 / T061 / T062 do NOT apply** — the regression guards assert no-duplicate-effect (monotonic guard) only, not identical-replay-response.

**Rationale:** FR-063's reworded two-strength model (no-duplicate-effect for all ops; identical-replay-response for key-bearing ops) is **fully satisfied** by isolate — the shipped ops already meet the no-duplicate-effect floor (Constitution §XI) via their monotonic guard. Retrofitting a key onto live ops is a behavior change with no v1 requirement driving it; it is recorded as an **optional future enhancement**, not v1 scope. This keeps 007 additive and avoids a second behavior change to shipped ops (T002 is already one).

**Asymmetry note:** T002 defaults to *tighten* (the alternative violates a MUST NOT) while T003 defaults to *isolate* (the alternative is an optional enhancement). The two SIGN-OFFs look parallel but are not — recorded here so a future reader does not mistake isolate-for-T003 as license to also isolate (leave-unchanged) for T002.

---

## Merged on `main`

_None yet._ The 007 planning chain is committed on `spec/007-unknown-items-review-queue-api` (3 commits, see TL;DR) but not merged. No application code, schema, or OpenAPI YAML has been changed — the OpenAPI extension is the `[GATED]` T010 slice, not yet executed.

---

## Local only — committed/uncommitted, not on `main`

| Stage | Subject | Reference |
|---|---|---|
| Spec + clarify + plan + Phase 0/1 | spec.md (10 US, 35 own-FR, 11 SI, 9 SC; 3 clarifications), plan.md (Constitution PASS ×2, 005 dependency-readiness map), research.md (R1–R6), data-model.md, contracts/README.md, quickstart.md, checklists/requirements.md | `aab701d` |
| tasks.md (Phase 2) | 39 dependency-ordered tasks; RED/GREEN + Predecessors/Acceptance house style; GATED-first | `45ae621` |
| Analyze remediation | T074 (FR-053 determinism), T075 (FR-054 system-failure retry), T076 (FR-023/045/SC-003 absence-guard) + FR traceability refs; 42 tasks | `8a97e97` |
| SIGN-OFF decisions | This document — T002 = tighten, T003 = isolate | (this commit) |

---

## Active findings

_None._

## Next recommended action

1. **Request `[GATED]` approval** for T010 (extend `packages/contracts/openapi/catalog/unknown-items.yaml`). Per the T002 verdict, this slice also reconciles 005's `sale_context` conformance expectations.
2. **Dispatch the RED→GREEN pairs** per `tasks.md` §13 critical path: T010 (GATED) → foundational RED/GREEN (T020–T025) → US story pairs → polish (T070–T076) → T073 (this wave-status final update).
3. Per standing rules: no implementation, push, or PR without explicit instruction.
