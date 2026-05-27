# ADR 0002 — Retail Tower OS Repository Boundaries

**Status**: Proposed
**Date**: 2026-05-27
**Owner**: Ahmed Shaaban
**Constitution version**: v3.0.0
**Feature / Ref**: Architecture operating model — [docs/architecture/](../../../docs/architecture/retail-tower-operating-model.md)

---

## Context

Retail Tower OS spans three repositories — Data-Pulse-2 (backend/source-of-truth),
POS-Pulse (cashier terminal), and Retail-Tower-Console (admin UI) — but the
division of responsibility had not been written down as a durable decision.
Without it, short Agent-OS prompts cannot resolve which repository a new
capability belongs to, and there is a standing risk of placing authorization,
pricing, or catalog *decisions* in a UI or terminal repo. The Constitution
already designates Data-Pulse-2 as owner of the backend, database, tenancy,
catalog, inventory, sales, billing, analytics, and POS sync APIs
(§Repository Scope), and requires all POS↔backend traffic to flow through
versioned, authenticated API contracts (§IV, §"The trust boundary"). This ADR
records the repository boundaries that follow from those principles, and the
default that capabilities start as modules rather than repositories.

This ADR is documentation only. It implements nothing.

---

## Decisions

### D1. Three repositories, three lifecycles

Data-Pulse-2 owns the backend and is the source of truth. POS-Pulse owns the
cashier terminal (offline-first, hardware). Retail-Tower-Console owns the
admin/management UI. Full owns/does-not-own lists are in
[docs/architecture/repo-boundaries.md](../../../docs/architecture/repo-boundaries.md).

### D2. Backend holds the truth

Authorization, tenancy, pricing, catalog, inventory, sales, billing, and audit
truth live in Data-Pulse-2 (§III). UIs and terminals render and request; they
never decide. Sibling repos consume the OpenAPI contract and never reach into the
database or undocumented endpoints (§IV).

### D3. Feature ≠ repository; module-first default

A capability defaults to a *module* in the repository that owns its domain. It
earns a new repository only when deployment, data lifecycle, security boundary,
or team ownership clearly diverge — gated by an ADR and the criteria in
[future-repo-split-criteria.md](../../../docs/architecture/future-repo-split-criteria.md).

| Alternative considered | Ruled out because |
|---|---|
| One repository per feature | Premature distributed-systems cost (cross-repo contracts, duplicated CI, version skew) before capabilities are validated. |
| Monorepo for all three surfaces | Conflates genuinely independent lifecycles (offline terminal, web admin, backend) that benefit from separate release cadence and ownership. |

---

## Consequences

- New work has a clear home; placement is decided by domain owner, not size.
- The number of cross-repo contracts stays minimal while the product is shaped.
- Sibling-repo boundaries here are *intended* and partly **unverified** (GitHub
  access is restricted to `data-pulse-2`); they must be reconciled against the
  actual POS-Pulse / Retail-Tower-Console repos when accessible.
- **Tradeoff**: keeping capabilities as modules can let a host repo grow large;
  accepted in exchange for avoiding premature splits, and revisited via the
  split criteria.

---

## Rejected alternatives

- **Repo-per-feature** — rejected (see D3 table): cost paid immediately, benefit
  hypothetical.
- **Single monorepo** — rejected (see D3 table): merges independent lifecycles.
- **No written boundaries (status quo)** — rejected: short prompts cannot resolve
  placement, inviting truth leakage into UI/terminal repos.

---

## Hard out-of-scope

- Any product code, schema, contract, or CI change.
- Creating, renaming, or restructuring any repository.
- Editing POS-Pulse or Retail-Tower-Console.

---

## Constitution Alignment

| Principle | Relationship |
|---|---|
| III. Backend Authority & Data Integrity | strengthened — truth stays in the backend |
| IV. Contract-First POS Integration | strengthened — OpenAPI is the only cross-repo surface |
| §Repository Scope | restated and made operational |

No principle tension.

---

## Open Questions

1. none (boundaries follow directly from the Constitution).

---

## Follow-up work

- Reconcile the **unverified** POS-Pulse / Retail-Tower-Console boundary lines
  against those repositories when access is available.
- Reference this ADR from the active spec's `wave-status.md` so placement
  decisions cite it.

---

## References

- [docs/architecture/retail-tower-operating-model.md](../../../docs/architecture/retail-tower-operating-model.md)
- [docs/architecture/repo-boundaries.md](../../../docs/architecture/repo-boundaries.md)
- [Constitution §Repository Scope, §III, §IV](../constitution.md)
- [docs/ARCHITECTURE.md](../../../docs/ARCHITECTURE.md)
