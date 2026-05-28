# ADR 0003 — OpenAPI as the Single Contract Source

**Status**: Proposed
**Date**: 2026-05-27
**Owner**: Ahmed Shaaban
**Constitution version**: v3.0.0
**Feature / Ref**: Architecture operating model — [docs/architecture/](../../../docs/architecture/retail-tower-operating-model.md)

---

## Context

Three repositories integrate with the backend: POS-Pulse and Retail-Tower-Console
both consume Data-Pulse-2 APIs. If each repository hand-wrote its own client or
relied on informal endpoint knowledge, the surfaces would drift and the backend
would lose authority over the integration shape. The Constitution already names
OpenAPI in `packages/contracts/openapi/` the "integration contract of record"
(§IV, §POS Integration Contract Standards) and forbids direct DB access or
undocumented endpoints (§"The trust boundary"). This ADR records that OpenAPI is
the *single source* from which all cross-repo clients are generated, and that the
source lives only in Data-Pulse-2.

This ADR is documentation only.

---

## Decisions

### D1. OpenAPI in Data-Pulse-2 is the contract of record

`packages/contracts/openapi/` is the authoritative, versioned description of
every cross-repo API. It is owned exclusively by Data-Pulse-2 and is a `[GATED]`
path — changes require explicit approval.

### D2. Clients are generated, not hand-written

Sibling repos consume API clients generated *from* the OpenAPI source, packaged
and distributed to consumers. No sibling repo authors its own contract or calls
undocumented endpoints.

| Alternative considered | Ruled out because |
|---|---|
| Each repo hand-writes its client | Guarantees drift and silent contract skew; backend loses authority over the shape. |
| Code-first (generate spec from backend handlers) | Spec becomes an after-the-fact artifact; harder to gate and review before implementation (§IV is contract-first). |
| Share TypeScript types directly across repos | Couples repos at the source level and bypasses the versioned, language-agnostic contract boundary. |

---

## Consequences

- One place to review and gate the integration surface; consumers stay in sync by
  regenerating clients.
- Contract changes are deliberate and reviewable (the spec is the gate, not the
  code).
- **Tradeoff**: requires generation tooling and a distribution channel for the
  generated clients; accepted as the cost of a single authoritative surface.
- Generated client *output* is not the source; it must never be edited by hand in
  consuming repos.

---

## Rejected alternatives

- **Hand-written clients per repo** — rejected (D2 table): drift.
- **Code-first spec generation** — rejected (D2 table): not contract-first.
- **Direct cross-repo type sharing** — rejected (D2 table): source-level coupling.

---

## Hard out-of-scope

- Any change to OpenAPI contracts, schemas, or generation tooling (this is a
  decision record, not an implementation).
- Choosing a specific client-generator or package registry.

---

## Constitution Alignment

| Principle | Relationship |
|---|---|
| IV. Contract-First POS Integration | strengthened — OpenAPI is the of-record source |
| XII. Authorization & Object Safety | strengthened — a single typed surface reduces object-safety gaps |
| §POS Integration Contract Standards | restated |

No principle tension.

---

## Open Questions

1. Which generator and distribution channel will publish the generated clients?
   (Deferred to an implementation spec.)

---

## Follow-up work

- An implementation spec to select the client generator and publishing pipeline.
- Document the regeneration workflow for Console and POS-Pulse consumers.

---

## References

- [docs/architecture/feature-placement-rules.md](../../../docs/architecture/feature-placement-rules.md)
- [Constitution §IV, §POS Integration Contract Standards](../constitution.md)
- [packages/contracts/openapi/](../../../packages/contracts) (contract of record — `[GATED]`)
- [docs/ARCHITECTURE.md](../../../docs/ARCHITECTURE.md)
