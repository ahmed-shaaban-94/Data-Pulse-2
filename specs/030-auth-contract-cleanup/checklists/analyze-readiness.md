# Analyze-Readiness Checklist — Draft D4 DP-2 Auth Contract Cleanup (Role-Named Security Schemes, additive)

> **SHIPPED — MERGED to `main` 2026-06-12** (PR #551 `33515a6`). This artifact is the as-built record; the original SPECIFY/DRAFT framing is superseded.

**Created:** 2026-06-12.  **Mode:** SPECIFY-ONLY / DRAFT.  **Spec:** [../spec.md](../spec.md).  **Branch:** `docs/028-followups-analyze` (off `origin/main`).

## A. Requirement -> task coverage (the verdict discriminator)

- [x] **Every goal G-1...G-8 has >=1 covering task.** *(ANALYSIS section 2.1 matrix — G-1->T4/T6, G-2->T9, G-3->T4/T5, G-4->T6, G-5->T8, G-6->T2/T3, G-7->T7/T12, G-8->T4+T6+T8. No uncovered goal.)*
- [x] **Every acceptance criterion A-1...A-10 has a covering task or is satisfied by artifact nature.** *(ANALYSIS section 2.2 — A-1..A-9 map to tasks; A-10 is a draft-level/meta criterion satisfied by the SPECIFY/DRAFT framing, correctly NOT mapped to a post-dispatch task.)*
- [x] **No orphan task** (every T1...T12 traces back to a goal/criterion or named rollout step). *(ANALYSIS section 2.3 — T12 is supporting handoff per spec section 6, not an orphan.)*
- [x] **No duplicated requirement or task.** *(ANALYSIS section 2.3 — distinct device family (T4/T5) vs operator-identity family (T6) vs negatives (T7/T8); no overlap.)*
- [x] **A-10 not mis-flagged as a coverage gap.** *(ANALYSIS section 2.2 note — classified "satisfied by artifact nature," preventing a false NEEDS-FIX.)*

## B. Gate-tag correctness

- [x] **Gate set is G10 + G2, and G3 is explicitly excluded.** *(spec Clarifications Q5, N-4, A-8; plan "No G3"; tasks gate legend "No [G3] appears".)*
- [x] **No `[G3]` tag appears on any task.** *(tasks.md T1-T12 carry only `[G10]`/`[G2]`; verified by reading the full task list.)*
- [x] **G10 labeled gated; readiness != dispatch-authorization.** *(spec authoring notes + Dependencies "gated — requires owner approval + G10 verification"; plan Gate preconditions.)*
- [x] **G3 tripwire present** (any proposed DB migration => classification wrong). *(plan Risk/scope-leak guards; tasks Scope-leak tripwires.)*

## C. Deferral-fence integrity (sale-sync held to D1)

- [x] **Sale-sync rename fenced OUT and deferred to D1.** *(spec N-2, A-7, section 4 table; tasks T7 — a negative-success task; plan Phase 2 "Do NOT touch sale-sync".)*
- [x] **T7 is a negative test** (success = sale-sync `security:` unchanged + D1 handoff note). *(tasks.md T7; tripwire "any edit to sale-sync security => scope leaked into D1 => stop".)*
- [x] **`readSale` correctly held** (its DEFER rationale is D2 phantom-guard; folded into the same D1/D2 slice). *(spec section 4 table readSale row; ANALYSIS F-4 flags the minor rationale-wording nuance — non-blocking.)*
- [x] **D1->D4 edge REFUTED is recorded** with the single carved-out coupling. *(spec Dependencies; tasks DAG note; ANALYSIS section 3.1.)*

## D. Evidence anchors — re-verified against `origin/main` (not echoed from the spec)

- [x] **16 files contain the `clerkJwt` string.** *Verified:* `git ls-tree -r` + per-file grep over `packages/contracts/openapi/` returns exactly 16 files. *(E-1; ANALYSIS section 1.)*
- [x] **Exactly 7 POS contracts carry active `- clerkJwt: []` refs, with matching per-file counts.** *Verified:* read-down=2, unknown-items=1, pos-audit-events=1, pos-operators=5, vouchers=4, sales=4, pos-shifts=1. *(E-1/E-6; matches spec section 4 / E-6 counts exactly.)*
- [x] **Connector/erpnext `clerkJwt` mentions are prose-only (0 active refs) and surfaces are already role-named.** *Verified:* `cookieAuth: []` active on connector-admin / reconciliation / console-sync-ops; `connectorBearer: []` active on posting-feed / stock-view; none carry active `clerkJwt`. *(E-6; ANALYSIS section 1.)*
- [x] **read-down is the canonical device-token mislabel with an in-file deferred-rename note.** *Verified:* `bearerFormat: JWT` intentionally omitted; in-file comment names `posDeviceAuth` as "a separate cross-contract decision"; `Authorization: Bearer <device_token> — an opaque token (NOT a JWT)`. *(E-2.)*
- [x] **sale-sync is a genuine Clerk JWT + `X-Device-Attestation` (Option-Y).** *Verified:* sales.yaml `clerkJwt` = `scheme: bearer` + `bearerFormat: JWT`; `X-Device-Attestation` header present; 4 active refs. *(E-3.)*
- [x] **sign-in is a genuine provider-identity JWT.** *Verified:* pos-operators.openapi.yaml 5 active refs; description verifies the Clerk JWT as operator identity proof. *(E-4.)*
- [x] **No unverified status asserted as done** — "no role-named scheme exists on `origin/main`" stated; target labeled target. *(spec E-5, A-10, N-8.)*

## E. Additive / doc<->runtime-honesty guarantee

- [x] **Every renamed surface's target scheme matches the credential verified today** (per-op confirmation precedes any rename). *(spec G-6, A-6; plan Phase 0; tasks T2/T3 with ambiguity=>DEFER default.)*
- [x] **No contract describes unbuilt behavior** — the doc-describes-unbuilt tripwire reclassifies to DEFER. *(plan Risk guards; tasks tripwires.)*
- [x] **Two role-named schemes only; no `service` scheme created.** *(spec section 5; plan Phase 1 "No `service` scheme is created"; tasks T8 negative; constitution Principle IV alignment preserved — operationIds untouched.)*

## F. Forbidden-surface / process compliance (this pass)

- [x] **Only two artifacts added** — `ANALYSIS.md` + `checklists/analyze-readiness.md`; no code/contract/OpenAPI/migration/package/lock/CI/secret. *(ANALYSIS section 4; `git status` shows no tracked-file edits.)*
- [x] **Existing spec/plan/tasks/requirements read-only** — not edited by this pass. *(F-1...F-4 are recorded as recommendations, not applied.)*
- [x] **Owning/sibling-repo contracts read read-only** via `git show origin/main:` only — no checkout/edit. *(ANALYSIS section 1 / section 4.)*
- [x] **No git side effects** — nothing staged/committed/pushed/PR'd; operated on the pre-created `docs/028-followups-analyze` branch only. *(ANALYSIS section 4.)*
- [x] **No secrets emitted** — credential *names*/*shapes* only (`clerkJwt`, `connectorBearer`, `cookieAuth`, `device_token`), no token values. *(this checklist + ANALYSIS.)*
- [x] **All artifacts marked SPECIFY/DRAFT and gated.** *(ANALYSIS header + footer; this header.)*

## G. Open / owner-facing residuals (recorded by this pass — none are blockers)

- [ ] **F-1 — fix stale path in `requirements.md` line 56** (`docs/specs/drafts/028-followups/...` -> `specs/030-auth-contract-cleanup/`). *Owner edit; not applied here (read-only on existing files).*  **LOW.**
- [ ] **F-2 — narrow T2 credential buckets** to drop the unused "service bearer" bucket (no `-> service` classification exists, E-6). *Owner/plan-phase edit.*  **LOW.**
- [ ] **F-3 — tighten T1** from "across the 16 contracts" to "the 7 active POS contracts (16 string-bearing, 9 prose-only)." *Owner/plan-phase edit.*  **LOW.**
- [ ] **F-4 — split T7 deferral rationale** (capture/void/refund = D1 envelope; `readSale` = D2 phantom guard). *Optional cosmetic.*  **LOWEST.**
- [ ] **Plan-phase per-operation runtime confirmation** for "verify in plan phase" surfaces (audit-events, shifts, terminal-pairing, vouchers, catalog reads beyond read-down) before assigning a role-named scheme (G-6). *D4-OQ-2; owning-repo plan phase.*
- [ ] **G10 verification + scoped owner approval** required before any dispatch. *Gate precondition — not satisfiable by this pass.*

---

**Readiness verdict (this checklist): READY** — sections A-F all pass; section G items are LOW recommendations and gate preconditions, none blocking internal dispatch-readiness. Dispatch remains gated on **G10 + scoped owner approval**.

> **Docs-only record (SHIPPED — MERGED to `main` 2026-06-12, PR #551 `33515a6`).**
