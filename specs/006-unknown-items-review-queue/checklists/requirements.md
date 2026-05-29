# Specification Quality Checklist: Unknown Items Review Queue

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-05-23
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- This spec is product-level only. It deliberately omits API, UI, data model, and contract detail. Future UI work is routed through Impeccable (spec §11).
- The "reopen" lifecycle decision (US8 / FR-061) is resolved by consuming 005 FR-005 semantics — fresh `pending` record, prior `dismissed` row preserved as audit history. This keeps 005's monotonic lifecycle (005 FR-004) intact.
- Bulk actions are intentionally constrained to bulk **dismiss** only (FR-070–FR-073). Bulk link, create, and reopen are explicitly out of scope for v1.
- All isolation, audit, and conflict semantics consume 005 § 6.5 / §6.9 / §7 — 006 introduces no parallel models.
- No open questions remain blocking. UI-level questions are routed to Impeccable (§11) rather than left as `NEEDS CLARIFICATION`.
- Items marked incomplete (none currently) would require spec updates before `/speckit-clarify` or `/speckit-plan`.

---

## Reviewer packet (T010–T019 per-user-story sign-offs)

> **Status: prepared for human review, NOT signed off.** This packet was prepared
> by an agent (Claude) to do the analytical legwork for the T010–T019 reviewer
> slices: for each user story it restates the acceptance basis from [spec.md](../spec.md)
> §5, gives an agent assessment of whether the spec's acceptance scenarios +
> Independent Test cover the story, and flags anything a reviewer should weigh.
> **The sign-off itself is a human attestation** — a reviewer reads the spec
> against this packet and records their own judgement in the Sign-off log below.
> An agent assessment is decision-support, not the attestation. Per each slice's
> stop condition: *if review surfaces a user-story ambiguity, open a
> `/speckit-clarify` slice instead of signing off.*

Each user story is `[Priority]`; acceptance scenarios and Independent Tests are in
spec.md §5. 006 is a product-level spec that **consumes** 005's mechanisms (link /
create / dismiss semantics, isolation SI-004, audit §6.9, conflict §6.5) — so most
acceptance scenarios are phrased as "per 005 FR-0xx". A key review lens is therefore:
*does the scenario correctly delegate to an existing, shipped 005 guarantee, or does
it assume something 005 does not provide?*

| Slice | US | Pri | Acceptance basis (spec.md §5) | Agent assessment | Reviewer should weigh |
|---|---|---|---|---|---|
| T010 | US1 — tenant admin reviews across permitted stores | P1 | 2 scenarios + Independent Test (a–d): cross-store visibility, per-item metadata, no cross-tenant leak, unguessable ids | Coverage looks complete; isolation delegates to 005 SI-004 + RLS. Scenario 2 (capture-while-reviewing → next-refresh) correctly defers live-push to FR-090. | Confirm "next refresh" (not live push) is an acceptable v1 UX commitment. |
| T011 | US2 — store operator scoped visibility | P1 | 4 scenarios + Independent Test (a–d): only S1 items; S2 absent from listings/filters/search/counters/empty-states; act-by-id → non-disclosing not-found; mid-session access loss (FR-090) | Strong; the "absent from counters AND empty states" clause closes the usual leak vectors. Scenario 4 (mid-session revoke) ties to FR-090. | Confirm FR-090 stale-state refresh is specified concretely enough for a future API/UI to implement without re-clarifying. |
| T012 | US3 — filter / sort / group safely | P1 | scenarios + Independent Test: filters only offer in-scope stores/sources; sort+group respect scope; empty results never leak out-of-scope existence | Covers the scope-leak surface well. | Confirm grouping-by-store for a tenant admin spanning many stores has no implied count disclosure across scope. |
| T013 | US4 — inspect item with safe, sufficient context | P1 | 4 scenarios + Independent Test (a–c): identifier/store/source/age/state shown; cross-store operator → non-disclosing not-found; "previously dismissed once" advisory; sale_context jsonb MUST NOT surface (FR-021a) | Coverage complete; the sale_context suppression (scenario 4) is an explicit MUST and aligns with 005 FR-006. | Confirm the advisory "previously dismissed" marker (scenario 3) is non-disclosing across scope — spec says so; verify no count leakage. |
| T014 | US5 — link to existing product | P1 | 4 scenarios + Independent Test: link success → resolved/linked + audit; non-active target → target-unavailable; alias-uniqueness conflict → non-disclosing, no mutation; concurrent race → exactly one wins | Fully delegates to shipped 005 link semantics (FR-050/051, §6.5, US3/SC-007). Low risk — 005 surface is on main and tested. | Confirm 005's link path is the one wired; 006 adds no new link mechanic. |
| T015 | US6 — create new product | P1 | 5 scenarios + Independent Test (a–e): atomic create+alias+transition; alias conflict → fail-closed; missing fields → validation; race → one wins; subsequent POS scans resolve to new product | Delegates to 005 FR-060/062/063 (atomicity). Scenario 5 ties forward to 005 FR-022 (POS resolution). Complete. | Confirm "minimal required fields" matches the 005 tenant-product contract exactly (no 006-specific field set). |
| T016 | US7 — dismiss | P2 | 3 scenarios + Independent Test (a–c): dismiss → dismissed, no side-effects, audit; POS resubmit → fresh pending (005 FR-005); double-dismiss → already-reconciled | Complete; consumes 005 FR-003/004/005. The terminal-state re-dismiss (scenario 3) carries a `details` discriminator per FR-100. | Confirm the advisory "previously dismissed once" hint is MAY (not MUST) — spec says MAY; verify no v1 obligation is implied. |
| T017 | US8 — reopen (tenant-wide only) | P2 | 6 scenarios + Independent Test (a–f): reopen = fresh pending (NOT lifecycle reversal); original dismissed row preserved; already-pending guard; store-operator reopen → forbidden; out-of-scope → not-found; auditable | Most nuanced story. The forbidden-vs-not-found split (scenarios 4/5) is subtle but correctly grounded in FR-062a + 005 SI-004 + the 2026-05-24 clarification. | **Highest-scrutiny item.** Verify the `forbidden` (in-scope, no authority) vs `not-found` (out-of-scope) distinction is unambiguous to a future API implementer — this was a clarification point, worth a careful read. |
| T018 | US9 — non-disclosing failure outcomes | P2 | 3 scenarios + Independent Test: every FR-100 category (8: validation, target-unavailable, alias-conflict, idempotency-token-mismatch, already-reconciled [+`details.prior_state`], not-found, forbidden, system-failure); no out-of-scope existence leak | Complete; FR-100's closed set was revised 2026-05-24 to add `forbidden`. The `already-reconciled` sub-cases (race vs static-state) via `details.prior_state` are well-specified. | Confirm the 8-category closed set is internally consistent with 005 FR-091's 7 categories + `forbidden`; no orphan category. |
| T019 | US10 — all decisions auditable | P2 | 3 scenarios + Independent Test: every action (link/create/dismiss/reopen + each failed attempt) → audit event w/ tenant/store/actor/action/target/correlation-id; via 005 FR-083 surface; no parallel channel | Complete; fully consumes 005 §6.9 audit. Scenario 2 (failed attempts audited where 005 FR-082 mandates) is the key check. | Confirm 006 truly adds no parallel audit channel — all events flow through 005 FR-083's existing surface. |

**Cross-cutting reviewer note:** 006 is a *delegating* spec. Almost every guarantee resolves to a 005 FR that is already shipped on `main` (Waves 1+2 complete). The main review risk is not missing coverage but **incorrect delegation** — a scenario that cites a 005 FR which doesn't actually provide what 006 assumes. The packet above flags US8 (reopen authority split) and US6 (minimal-fields contract) as the two worth the closest read; the rest are low-risk delegations to tested 005 surfaces.

---

## Sign-off log

> One dated entry per user-story sign-off (T010–T019). **A reviewer with the
> authority to attest fills these in** — replace the placeholder, record the date
> and reviewer identity, and either SIGN-OFF or (if an ambiguity surfaced) note the
> `/speckit-clarify` slice opened instead. The agent-prepared reviewer packet above
> is input to this judgement, not a substitute for it.

**Entry format** (the reviewer adds a real heading of the form `### T0NN sign-off — USx (...)`
when signing — that exact heading is what each slice's validation grep looks for, so it
MUST NOT appear until a human actually signs). Fields per entry:

- `Date:` YYYY-MM-DD
- `Reviewer:` name / role (the attesting human)
- `Verdict:` SIGNED-OFF | CLARIFY-OPENED
- `Notes:` judgement against that US's acceptance scenarios + Independent Test; reference the reviewer-packet row above

Example shape (intentionally written WITHOUT the literal `### T0NN sign-off` heading so it
does not satisfy any slice's validation grep): a signed T010 entry would be a level-3
heading reading "T010 sign-off — US1 ...", followed by the four fields above.

_No sign-offs recorded yet. Awaiting human reviewer (T010–T019). Each slice's validation
grep (`^### T0NN sign-off`) intentionally still returns no match — these are unsigned._
