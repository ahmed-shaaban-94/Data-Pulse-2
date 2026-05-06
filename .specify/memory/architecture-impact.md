# Architecture Impact Map — pre-flight discipline

> **Status**: Active rule. Referenced from
> [`.specify/memory/constitution.md`](constitution.md) Working Agreement
> appendix.
> **Constitution version at introduction**: v3.0.1.
> **Scope**: applies to every feature spec and every architecture-affecting
> implementation plan in this repository going forward.

This document defines the **Architecture Impact Map** rule, the required
dimensions, the permitted exception for low-impact changes, and the
relationship of this rule to the Constitution Check and the Working
Agreement.

---

## Rule

Every feature spec, and every implementation plan whose change is
architecture-affecting, MUST include an **Architecture Impact Map** before
implementation begins.

Any implementation task that changes architecture MUST update the
Architecture Impact Map of its parent spec or plan **before**
implementation, not after. A stale map is treated as a missing map.

The map is a *delta-focused* artifact — it describes **what surface this
spec / plan / task moves**, not a static system overview. (Plans MAY also
carry a separate static "Architecture Overview" section; the two are not
substitutes for each other.)

Every map MUST begin with two front-matter sections, in this order:

1. **Impact Classification** — a single-line severity verdict plus the
   boundaries this change crosses.
2. **Triggered Review Gates** — the seven pre-defined gates, each
   ticked or unticked, with a one-line pointer to the required artifact
   for every ticked gate.

The dimension table from `## Required dimensions` follows after these
two sections.

---

## Impact Classification

Every Architecture Impact Map MUST start with the following block. It is
machine-scannable: the `Impact level:` field MUST be one of exactly five
tokens (`None`, `Low`, `Medium`, `High`, `Critical`) and the boundary
crossings MUST default to `none` when genuinely none.

```
- Impact level: None | Low | Medium | High | Critical
- Reason: <one or two sentences>
- Boundary crossings:
  - API → Worker: none | <one-line note>
  - API → DB: none | <one-line note>
  - Worker → DB: none | <one-line note>
  - Package boundary: none | <one-line note>
  - External provider: none | <one-line note>
  - OpenAPI/codegen: none | <one-line note>
  - Runtime/deployment: none | <one-line note>
```

### Severity glosses

Authors choose the level that **best fits the highest-impact change in
the slice**. When in doubt, classify up.

- **None** — Documentation-only, comment-only, or a single-expression
  internal bugfix with no public-surface, schema, contract, queue, or
  dependency move. Equivalent to the "No architecture impact" exception.
- **Low** — Internal refactor or new code that is fully contained inside
  one module / package, touches no DB schema, no contract, no queue, no
  dependency, no auth path. No new boundary crossing.
- **Medium** — Change touches one architectural boundary in a controlled,
  reviewable way: e.g., one new endpoint reading existing tables, one new
  consumer of an existing queue, one new internal helper consumed by an
  existing module. No schema migration, no new external provider, no
  auth-surface change.
- **High** — Change touches multiple boundaries, OR introduces a new
  schema migration, OR introduces a new queue / scheduled job, OR
  introduces a new package dependency, OR changes the auth / session /
  token surface, OR changes an OpenAPI contract.
- **Critical** — Change touches the trust layer of the system: tenant
  isolation, RLS posture, cross-tenant data flow, audit-event emission,
  PII classification, money representation, or POS contract surface.
  Also: any irreversible migration, any cross-tenant aggregate, any
  external-provider integration on a hot path. Critical changes require
  an ADR under `.specify/memory/decisions/` regardless of size.

### Floor rule

If **any** Triggered Review Gate (next section) is checked, `Impact
level:` MUST be at least **Medium**. A ticked gate paired with `Impact
level: None` or `Low` is a defect; the author MUST either raise the
level or remove the gate (and justify why the gate does not apply).

### Boundary-crossings discipline

- Default value for every crossing is the literal token `none`.
- If a crossing is populated, the value MUST be a one-line note that
  identifies the concrete surface (e.g., `API → DB: new read of
  memberships.role to resolve store-access policy`). Bare `yes` is a
  defect.
- A populated crossing implies the corresponding dimension row in
  `## Required dimensions` is also populated; an inconsistency between
  the two is a defect.

---

## Triggered Review Gates

After the Impact Classification block, every map MUST include the
following gate checklist. Authors tick each gate that applies. **Every
ticked gate MUST be paired with a one-line pointer to the required
artifact** — a test path, a threat-review note, a dependency-approval
PR / issue link, an RLS-test path, etc. A ticked gate without a pointer
is a defect; reviewers MUST reject the map.

```
- [ ] DB read/write → RLS / tenant-context strategy required.
      Pointer: <test path or strategy note>
- [ ] OpenAPI / API contract change → contract validation and codegen
      impact required.
      Pointer: <YAML path + conformance test path>
- [ ] Queue / job publish or consume → producer / consumer contract
      tests required.
      Pointer: <producer test path + consumer test path>
- [ ] Auth / session / token change → threat review, generic refusal,
      and audit / redaction review required.
      Pointer: <ADR or threat-review note path>
- [ ] Package dependency change → explicit approval required.
      Pointer: <PR / issue link recording approval>
- [ ] Cross-package or cross-app import → boundary justification
      required.
      Pointer: <one-paragraph justification, in this section or in spec>
- [ ] External provider integration → verification, outage, and
      failure-mode plan required.
      Pointer: <ADR or failure-mode note path>
```

The seven gates are the closed set for this rule. Adding a new gate is
itself a change to this document and follows the same Working Agreement
update path.

---

## Required dimensions

The Architecture Impact Map MUST identify, at a minimum:

- **Affected modules / packages** in this monorepo (`apps/*`, `packages/*`).
- **Database tables read** and **database tables written** — named
  individually. "All tenant tables" is not acceptable.
- **APIs / OpenAPI contracts changed** — list `operationId`s and the
  contract YAML(s) under `packages/contracts/openapi/` that are added,
  modified, or whose status moves (e.g., `draft → stable`).
- **Events / jobs published or consumed** — BullMQ queues, scheduled jobs,
  webhook flows. Producer side and consumer side MUST be called out
  separately; one without the other is a defect.
- **Files likely to require edits** — concrete paths or glob patterns.
  "Many files in `apps/api`" is not acceptable; if the blast radius is
  broad, list the directories that anchor it.
- **Risky dependencies or package-boundary concerns** — new runtime
  dependencies, cross-package imports that would otherwise be forbidden
  by the workspace boundary, version pins under Principle VIII gating,
  transitive risk.
- **Regression test areas** — existing test suites or properties (RLS
  bypass probe, cross-tenant sweep, cross-store sweep, idempotency replay,
  audit-event emission, contract-conformance test) that this change could
  regress, and the test files / globs that cover them.

---

## "No architecture impact" exception

Small bugfixes, test-only changes, and documentation-only changes MAY
satisfy this rule with a reduced map. The reduced map MUST contain, at a
minimum:

```
- Impact level: None
- Reason: <one or two sentences explaining why no architecture is moved>
```

Authors MAY skip the **Boundary crossings** sub-block, the **Triggered
Review Gates** checklist, and the **Required dimensions** table when
(and only when) `Impact level: None` is asserted with a non-empty
`Reason:`.

Examples that qualify:

- Test-only change to an existing fixture; no module surface, schema,
  contract, queue, or dependency moves.
- Typo fix in a comment or docstring.
- README clarification with no code edits.
- Bugfix that changes a single internal expression and no public surface,
  no schema, no contract, no queue, no dependency.

Examples that do **NOT** qualify (must have a full map):

- Any new or modified DB table, column, index, RLS policy, or migration.
- Any new or modified `operationId`, request/response schema, or contract
  YAML.
- Any new or modified BullMQ queue, scheduled job, or webhook flow.
- Any new runtime dependency or version-pin change.
- Any cross-package import not previously allowed by the workspace
  boundary.
- Any change to authentication, authorization, tenant context, or audit
  event emission.

A bare "No architecture impact" assertion without `Impact level: None`
and a non-empty `Reason:` is insufficient. The reviewer is responsible
for challenging any "No architecture impact" claim that does not hold up
— in particular, claims paired with diffs that touch any of the
disqualifying examples above.

---

## Relationship to other gates

This rule is **independent of, and additive to**, the Constitution Check
(see `constitution.md` §Governance) and the Working Agreement pre-flight
plan.

- The **Architecture Impact Map** answers *what surface this PR moves*.
- The **Constitution Check** answers *which invariants it touches*.
- The **Working Agreement pre-flight plan** answers *what concrete task
  text and contract surface the implementer is about to act on*.

A PR can be Constitution-clean and still owe an impact map, and vice
versa. The Architecture Impact Map is **not** a Core Principle and is
**not** gated by the Constitution Check; it is an operating rule that
lives in the Working Agreement appendix.

The presence or absence of an impact map does not, by itself, change a
constitution version. Adding or materially changing this rule is itself a
Working Agreement change and follows the Working Agreement update path
(no constitution version bump required for routine edits to this file).

---

## Skeleton — drop-in for spec / plan

Authors of a new spec or plan MAY copy the block below verbatim into a
new section titled `## Architecture Impact Map`. The skeleton has three
parts in this order: **Impact Classification**, **Triggered Review
Gates**, and the **dimension table**. Replace placeholder text; write
`none` (lowercase) for genuinely empty rows; do not delete rows or
gates.

```markdown
## Architecture Impact Map

### Impact Classification

- Impact level: None | Low | Medium | High | Critical
- Reason: _(one or two sentences)_
- Boundary crossings:
  - API → Worker: none
  - API → DB: none
  - Worker → DB: none
  - Package boundary: none
  - External provider: none
  - OpenAPI/codegen: none
  - Runtime/deployment: none

### Triggered Review Gates

- [ ] DB read/write → RLS / tenant-context strategy required.
      Pointer: _(test path or strategy note)_
- [ ] OpenAPI / API contract change → contract validation and codegen
      impact required.
      Pointer: _(YAML path + conformance test path)_
- [ ] Queue / job publish or consume → producer / consumer contract
      tests required.
      Pointer: _(producer test path + consumer test path)_
- [ ] Auth / session / token change → threat review, generic refusal,
      and audit / redaction review required.
      Pointer: _(ADR or threat-review note path)_
- [ ] Package dependency change → explicit approval required.
      Pointer: _(PR / issue link recording approval)_
- [ ] Cross-package or cross-app import → boundary justification
      required.
      Pointer: _(one-paragraph justification, in this section or in spec)_
- [ ] External provider integration → verification, outage, and
      failure-mode plan required.
      Pointer: _(ADR or failure-mode note path)_

### Required dimensions

| Dimension | Impact |
|---|---|
| Affected modules / packages | _(e.g., `apps/api/src/auth/`, `packages/contracts`)_ |
| DB tables read | _(e.g., `users`, `memberships`; or `none`)_ |
| DB tables written | _(e.g., `auth_tokens`; or `none`)_ |
| APIs / OpenAPI contracts changed | _(operationId list + YAML path; or `none`)_ |
| Events / jobs published | _(queue name + producer; or `none`)_ |
| Events / jobs consumed | _(queue name + consumer; or `none`)_ |
| Files likely to require edits | _(concrete paths / globs)_ |
| Risky dependencies / boundary concerns | _(new deps, cross-package imports, version pins; or `none`)_ |
| Regression test areas | _(test files / suites that could regress; mandatory if any of the above is non-empty)_ |

> If this change is a small bugfix, test-only change, or docs-only change,
> the block above MAY be replaced by the reduced form:
>
> ```
> - Impact level: None
> - Reason: <one or two sentences explaining why no architecture is moved>
> ```
>
> The Boundary crossings sub-block, Triggered Review Gates, and the
> dimension table MAY be omitted in that case.
```

---

## Rationale

Most regressions in a multi-tenant SaaS arise not from violated principles
but from **unaccounted blast radius** — a contract drift the author did
not realise crossed the POS seam, a queue producer added without a
consumer, a schema column read by a worker that nobody listed.

The Architecture Impact Map makes blast radius an explicit, reviewable
artifact at spec / plan time, not at incident time. It prevents the "I
didn't know X depended on Y" class of incident, and it gives reviewers a
concrete checklist to challenge instead of a free-form "looks fine to me."

The cost is one small table per spec or plan. The benefit is that every
architecture-affecting change carries its blast radius on its face,
reviewable before code is written.
