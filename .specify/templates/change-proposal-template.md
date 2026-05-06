# Change Proposal: [Title]

**CP-ID**: CP-NNN
**Proposer**: [name or role]
**Date**: YYYY-MM-DD
**Status**: Draft | Under Review | Accepted | Rejected | Superseded by [spec-id]
**Constitution**: v3.0.1

---

## 1. Problem Statement

What is broken, missing, or sub-optimal?
One paragraph. Link the spec or principle this violates if applicable.

## 2. Goal

What does this proposal set out to achieve?
One or two sentences. State the desired end state, not the mechanism.

## 3. Non-Goals

What is explicitly out of scope for this proposal?

- ...
- ...

## 4. Current Behavior

What does the system do today? How does the current flow work?
Reference the relevant spec section, task ID, or code path if helpful.
Keep this factual — describe what is, not what should be.

## 5. Proposed Behavior

What does the system do after this change?
Describe the new flow as a concrete before → after or as a step-by-step
description of the changed path. Focus on observable behavior.
Do not add §6 (functional requirements) or §7 (data model) here —
those belong in `spec.md` if a full spec is required.

## 6. Spec / Contract Deltas

List every artifact that would change if this proposal is accepted.
Write `none` if the item genuinely does not change.

| Artifact | Change |
|---|---|
| Spec sections (spec.md §N) | none \| [section title — one-line description of delta] |
| OpenAPI operationIds | none \| [operationId — added / modified / removed] |
| Contract YAML paths | none \| [path under `packages/contracts/openapi/`] |
| DB schema / migration | none \| [table + column / index / policy] |
| tasks.md tasks | none \| [T-NNN — new / modified / removed] |
| Other | none \| ... |

## 7. Architecture Impact (preliminary)

- Impact level: None | Low | Medium | High | Critical
- Surfaces affected: [brief — API, DB, contract, queue, dependency]
- Does this require a full spec? Yes | No | TBD

For a full Architecture Impact Map skeleton, copy from
`.specify/templates/architecture-impact-map-template.md` and embed it here,
or attach it as a separate file referenced from Next Steps.

## 8. Constitution Alignment

Which Core Principles (I–XIV) does this touch?
Which does it strengthen?
Any principle tension to resolve?

## 9. Alternatives Considered

| Option | Rejected because |
|---|---|
| ... | ... |

## 10. Rollout Plan

How does this change reach production safely?

- [ ] Step 1 — [e.g., spec approved]
- [ ] Step 2 — [e.g., migration reviewed and staged]
- [ ] Step 3 — [e.g., feature flag / dark launch / cut-over]
- [ ] Step 4 — [e.g., old path removed]

Write `N/A — docs/process only` if this proposal has no production rollout.

## 11. Validation Plan

How do we know the change is correct after implementation?

- [ ] [e.g., existing test suite X continues to pass]
- [ ] [e.g., new integration test for scenario Y]
- [ ] [e.g., manual smoke test steps]
- [ ] [e.g., CI gate — which jobs must be green]

## 12. Risks

| Risk | Likelihood | Severity | Mitigation |
|---|---|---|---|
| ... | Low / Med / High | Low / Med / High | ... |

## 13. Stop Conditions

List the conditions that would cause this proposal to be abandoned or
redesigned mid-implementation. Be specific.

- Stop if [condition] — because [consequence].
- Stop if [condition] — because [consequence].

## 14. Acceptance Criteria

Definition of done for this proposal (not the implementation — the proposal
itself is accepted when all of these are true).

- [ ] ...

## 15. Open Questions

Each must be resolved before moving to spec or implementation.

1. ...

## 16. Next Steps

- [ ] Open spec (if required)
- [ ] Open ADR under `.specify/memory/decisions/` (if Critical-level impact)
- [ ] Attach or embed full Architecture Impact Map
- [ ] Direct implementation (only if `Impact level: None` and no spec required)

---

> **When to use this template**
> Open a Change Proposal when you want to propose an architectural or process
> change before committing to a full spec. This is the async "should we do
> this at all?" gate. Use it for changes that cross a boundary (DB, API,
> contract, queue, auth) but are not yet fully specced.
>
> **When NOT to use this template**
> Already-approved task items in `tasks.md`. Bugfixes. Doc typo fixes.
> Test-only changes. Anything already fully specced in an active feature.
> Do not add §6 (functional requirements) or §7 (data model) sections here —
> those belong in `spec.md`.
