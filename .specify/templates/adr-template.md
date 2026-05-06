# ADR NNNN — [Title]

**Status**: Proposed | Accepted | Deprecated | Superseded by ADR-MMMM
**Date**: YYYY-MM-DD
**Owner**: [name or role]
**Constitution version**: vX.Y.Z
**Feature / Ref**: [spec-id, CP-ID, or PR link — omit if not tied to a feature]

---

## Context

What situation or pressure required a decision?

One to three paragraphs. Reference the relevant Constitution principle(s)
and the change that triggered this ADR. If a Change Proposal (CP) or an
Architecture Impact Map classification of **Critical** prompted this ADR,
link it here.

Include what is known, what is uncertain, and what constraints are fixed.
Do not state the decision here — that belongs in `## Decisions`.

---

## Decisions

### D1. [Short decision title]

State the decision directly. One to three paragraphs max.

If this decision was reached after evaluating alternatives, record the
winning option and the reason the alternatives were ruled out:

| Alternative considered | Ruled out because |
|---|---|
| ... | ... |

If the decision carries a known tradeoff or negative consequence, note it
as a sub-bullet under the decision body:

- **Tradeoff**: [what is accepted or deferred in exchange for this choice]

### D2. [Short decision title]

...

*(Add D3, D4, … as needed. Each MUST be a discrete, addressable decision
— not a narrative re-statement of the context.)*

---

## Hard out-of-scope

List what this ADR explicitly does NOT decide or cover.

- ...
- ...

---

## Constitution Alignment

Which Core Principles (I–XIV) does this ADR touch?

| Principle | Relationship |
|---|---|
| [e.g., II. Multi-Tenant SaaS by Default] | strengthened / constrained / in tension |
| [e.g., XII. Authorization & Object Safety] | strengthened |

Any principle tension to resolve? If yes, state how the decisions above
resolve it, or note it as an open question.

---

## Open Questions

Each must be resolved before implementation begins, or resolved in a
subsequent ADR or spec. If none, write `none`.

1. ...

---

## References

- [Spec or plan that owns this feature](../../../specs/NNN-feature/spec.md)
- [Constitution — relevant section](../constitution.md)
- [Change Proposal CP-NNN or Architecture Impact Map, if applicable]
- [External PR / issue / document that informed a decision]

---

> **When to use this template**
> Open an ADR under `.specify/memory/decisions/` when the Architecture
> Impact Map classifies a change as **Critical** (trust layer, RLS posture,
> cross-tenant data flow, audit-event emission, PII classification, money
> representation, POS contract surface, or irreversible migration). The
> change-proposal template §16 explicitly prompts this. Also use when
> adopting a third-party integration pattern that will constrain multiple
> future features and when a decision is difficult or costly to reverse.
>
> **When NOT to use this template**
> Low, Medium, or High impact changes — capture decisions in the spec's
> `§Architecture` or in the Architecture Impact Map instead. Routine
> task-level decisions already recorded in `tasks.md`. Bugfixes with no
> architectural surface change. Anything already fully decided in an active
> feature's `spec.md`.
>
> **File placement**: `.specify/memory/decisions/NNNN-kebab-title.md`
> where NNNN is the next sequential number after the highest existing ADR.
