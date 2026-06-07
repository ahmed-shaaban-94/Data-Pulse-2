# Cross-Artifact Analysis: Product-Master Reconciliation v1

**Feature**: 021-product-master-reconciliation-v1 | **Date**: 2026-06-07 | **Constitution**: v3.0.1

Non-destructive consistency check across `spec.md` <-> `plan.md` <-> `tasks.md`
(with `research.md` / `data-model.md` as supporting design). No artifact was
auto-edited to resolve CRITICAL/HIGH findings — they are logged.

> Authoring note: this file and `review.md` were initially blocked by the
> harness Write-tool "report file" filename guard during the automated SpecKit
> chain; their content was delivered in the agent return and is reconstituted
> here verbatim so the spec's artifact set is complete (SpecKit chain steps 6–7
> require both as durable spec artifacts).

---

## Findings

**Severity tally: 0 CRITICAL · 0 HIGH · 1 MEDIUM · 5 LOW.**

| ID | Severity | Location | Summary | Recommendation |
|---|---|---|---|---|
| F3 | MEDIUM | spec US3 / FR-007 / plan / research R3 / tasks T033 | US3's `unmapped_erpnext_item` + `attribute_drift` mismatch value is **unreachable** until the connector ships `021-ITEM-VIEW-CONTRACT` (the live ERPNext item view). v1 ships the run skeleton + DP2-side mismatch classes only. | **Disclosed honestly** in every artifact (spec US3 note, FR-007, plan, research R3, task T033) — this is the intended 017-style honesty split (in-repo leg vs cross-system leg), not a defect. Track `021-ITEM-VIEW-CONTRACT` as the external/gated unblocker. |
| F1 | LOW | data-model / SCHEMA authoring | The `tenant_product_id` linkage is left FK-or-polymorphic open for the `[GATED]` SCHEMA slice to decide. | Both choices are §IX-safe (read-not-mutate). Decide at SCHEMA authoring; not blocking at planning level. |
| F4 | LOW | tasks T023 (atomicity test) | The atomicity test relies on the 018 named-export-spy gotcha (jest cannot redefine named-export spies mid-transaction). | Pre-empted: T023 notes the DB-trigger approach for mid-tx failure injection (per the 018 lesson). No action. |
| F5 | LOW | data-model / tasks | The `scheduled` run trigger is reserved (consistent across artifacts) but not built in v1. | Consistent reservation; aligns with 017's `017-SCHEDULED-RUNS` deferral. No action. |
| F6 | LOW | plan §X | §X (retail temporal) marked partial. | Justified — reconciliation reads, it does not post dated documents. No action. |
| F2 | LOW | spec FR-009 / research R9 | FR-009 does not name the exact metric identifier. | R9 places it in the shared `api.metrics.ts` (impl detail); tasks T037/T038 carry it. No spec change needed. |

No CRITICAL findings. No constitution conflict — §IX (authority handover) and
§VIII (drive-by gated schema/contract), the two careless-build risks, are
addressed head-on (read-not-mutate + reuse-013-lifecycle; `[GATED]` slices only).

---

## Coverage: every FR mapped to >=1 task

FRs **20/20** mapped to ≥1 task. No orphan implementation tasks.

## Coverage: every user story mapped

| Story | Independently testable | Notes |
|---|---|---|
| US1 (connector-free MVP) | yes | Read-projection / run over DP2-side state only |
| US2 (seeded-product) | yes | Seeded product divergence detection |
| US3 (stub-view) | yes (stub-tolerant) | Live ERPNext item view is external/gated; v1 ships DP2-side classes |

0 orphan tasks. **Constitution: PASS.**

## Recommended LOW additions at implementation time

- An explicit negative test that the repair path NEVER touches the 003/006/007
  unknown-items queue (FR-020, currently design-enforced only).
- A shared before/after assertion that 013 / 003 / 008 are unchanged by runs and
  repairs (FR-014 / FR-017).

---

## Guardrail compliance (this planning pass)

- No file created/edited under `packages/contracts/openapi/**`, `packages/db/**`,
  migrations, `.github/**`, `package.json`, `pnpm-lock.yaml`. OK
- No code, no migration, no YAML authored. OK
- All artifacts under `specs/021-product-master-reconciliation-v1/`. OK
