# ADR 0007 — Infrastructure Repository Split Conditions

**Status**: Proposed
**Date**: 2026-05-27
**Owner**: Ahmed Shaaban
**Constitution version**: v3.0.0
**Feature / Ref**: Architecture operating model — [docs/architecture/](../../../docs/architecture/retail-tower-operating-model.md)

---

## Context

Deployment and infrastructure configuration are currently owned by Data-Pulse-2
(Constitution §Repository Scope lists "deployment and infrastructure
configuration" among what this repository owns). As the platform matures there is
a recurring question of when to extract a dedicated `Retail-Tower-Infra`
repository for IaC, secrets, environments, monitoring, backups, and disaster
recovery. This ADR records that infra stays in-repo until a clear independent
lifecycle emerges, and names the conditions for the split.

This ADR is documentation only.

---

## Decisions

### D1. Infra/deployment config stays in Data-Pulse-2 by default

Until a boundary test is met, deployment and infrastructure configuration remain
in Data-Pulse-2 alongside the application they deploy.

### D2. Extract Retail-Tower-Infra only on an independent lifecycle

Create `Retail-Tower-Infra` only when deployment, secrets, environments, backups,
monitoring, IaC, or disaster recovery need a lifecycle independent of application
code — i.e. the **deployment** and/or **security** boundary tests in
[future-repo-split-criteria.md](../../../docs/architecture/future-repo-split-criteria.md)
are clearly met (e.g. infra changes ship on a different cadence than app code, or
secrets/DR demand an isolation boundary a module cannot provide).

### D3. The split is ADR-gated and contract-preserving

The extraction is proposed in an ADR before it happens, and must not weaken the
reproducible-release guarantees of §VIII (gated, versioned, auditable releases).

| Alternative considered | Ruled out because |
|---|---|
| Dedicated infra repo now | No independent deploy/secrets/DR lifecycle exists yet; a split adds a second pipeline and ownership surface with no benefit. |
| Never split infra | Forecloses a real future boundary (separate DR/secrets ownership); the decision should be criteria-driven, not absolute. |
| Infra config in a sibling UI/terminal repo | Misplaces deployment ownership outside the backend that defines the runtime. |

---

## Consequences

- Infra changes stay co-located with the app while the team and cadence are
  unified — simpler review and release.
- The extraction path is explicit and criteria-gated, avoiding both premature
  and never-considered splits.
- **Tradeoff**: a single repo couples app and infra release cadence; accepted
  until that coupling becomes the actual pain that triggers the split.

---

## Rejected alternatives

- **Infra repo now** — rejected (D2 table): no lifecycle boundary yet.
- **Never split** — rejected (D2 table): forecloses a real future boundary.
- **Infra in a UI/terminal repo** — rejected (D2 table): misplaced ownership.

---

## Hard out-of-scope

- Implementing or relocating any IaC, secrets, monitoring, or CI configuration.
- Choosing infra tooling.

---

## Constitution Alignment

| Principle | Relationship |
|---|---|
| VIII. Reproducible & Versioned Releases | strengthened — split must preserve gated, auditable releases |
| §Repository Scope | restated — infra owned by Data-Pulse-2 until split |

No principle tension.

---

## Open Questions

1. Which concrete signal (separate deploy cadence vs. DR/secrets isolation) will
   first trigger the split? (Revisit when infra complexity grows.)

---

## Follow-up work

- Re-evaluate against the split criteria when deployment cadence or DR/secrets
  ownership diverges.
- If extracted, record the app↔infra interface and release-gating in a new ADR.

---

## References

- [docs/architecture/future-repo-split-criteria.md](../../../docs/architecture/future-repo-split-criteria.md)
- [Constitution §VIII, §Repository Scope](../constitution.md)
- [docs/architecture/retail-tower-operating-model.md](../../../docs/architecture/retail-tower-operating-model.md)
