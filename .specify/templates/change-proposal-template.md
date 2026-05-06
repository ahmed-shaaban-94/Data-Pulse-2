# Change Proposal: [Title]

**CP-ID**: CP-NNN
**Proposer**: [name or role]
**Date**: YYYY-MM-DD
**Status**: Draft | Under Review | Accepted | Rejected | Superseded by [spec-id]
**Constitution**: v3.0.1

---

## Problem Statement

What is broken, missing, or sub-optimal?
One paragraph. Link the spec or principle this violates if applicable.

## Proposed Change (delta only — not a full spec)

What specifically changes?
What explicitly stays the same?

## Architecture Impact (preliminary)

- Impact level: None | Low | Medium | High | Critical
- Surfaces affected: [brief — API, DB, contract, queue, dependency]
- Does this require a full spec? Yes | No | TBD

## Constitution Alignment

Which Core Principles (I–XIV) does this touch?
Which does it strengthen?
Any principle tension to resolve?

## Alternatives Considered

| Option | Rejected because |
|---|---|
| ... | ... |

## Acceptance Criteria

- [ ] ...

## Open Questions

Numbered list. Each must be resolved before moving to spec or implementation.

1. ...

## Next Steps

- [ ] Open spec (if required)
- [ ] Open ADR under `.specify/memory/decisions/` (if Critical-level impact)
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
