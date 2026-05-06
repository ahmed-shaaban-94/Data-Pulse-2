# Architecture Impact Map: [Feature / PR / Task Title]

**Ref**: [spec-id, PR number, or task ID]
**Author**: [name or role]
**Date**: YYYY-MM-DD
**Constitution**: v3.0.1

> **Canonical rule**: `.specify/memory/architecture-impact.md`
> Severity glosses, gate definitions, the "No architecture impact" exception,
> and the relationship to the Constitution Check all live there.
> Do not duplicate rule prose here — keep this file as a fill-in skeleton.

---

## Impact Classification

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

## Triggered Review Gates

- [ ] DB read/write → RLS / tenant-context strategy required.
      Pointer: _(test path or strategy note)_
- [ ] OpenAPI / API contract change → contract validation and codegen impact required.
      Pointer: _(YAML path + conformance test path)_
- [ ] Queue / job publish or consume → producer / consumer contract tests required.
      Pointer: _(producer test path + consumer test path)_
- [ ] Auth / session / token change → threat review, generic refusal,
      and audit / redaction review required.
      Pointer: _(ADR or threat-review note path)_
- [ ] Package dependency change → explicit approval required.
      Pointer: _(PR / issue link recording approval)_
- [ ] Cross-package or cross-app import → boundary justification required.
      Pointer: _(one-paragraph justification, in this section or in spec)_
- [ ] External provider integration → verification, outage, and failure-mode plan required.
      Pointer: _(ADR or failure-mode note path)_

## Required Dimensions

| Dimension | Impact |
|---|---|
| Affected modules / packages | _(e.g., `apps/api/src/auth/`, `packages/contracts`)_ |
| DB tables read | _(named individually, or `none`)_ |
| DB tables written | _(named individually, or `none`)_ |
| APIs / OpenAPI contracts changed | _(operationId list + YAML path, or `none`)_ |
| Events / jobs published | _(queue name + producer, or `none`)_ |
| Events / jobs consumed | _(queue name + consumer, or `none`)_ |
| Files likely to require edits | _(concrete paths / globs)_ |
| Risky dependencies / boundary concerns | _(new deps, cross-package imports, version pins, or `none`)_ |
| Regression test areas | _(test files / suites that could regress)_ |

---

> **Low-impact exception** — if `Impact level: None`, the Boundary crossings
> sub-block, Triggered Review Gates, and Required Dimensions table MAY be
> omitted. Replace the entire block above with:
>
>     - Impact level: None
>     - Reason: <one or two sentences explaining why no architecture is moved>
>
> See `.specify/memory/architecture-impact.md` for what qualifies and what
> does NOT qualify as a "None" classification.
