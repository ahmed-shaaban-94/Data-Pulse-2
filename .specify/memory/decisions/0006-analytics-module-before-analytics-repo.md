# ADR 0006 — Analytics Starts as a Module Before Becoming a Repository

**Status**: Proposed
**Date**: 2026-05-27
**Owner**: Ahmed Shaaban
**Constitution version**: v3.0.0
**Feature / Ref**: Architecture operating model — [docs/architecture/](../../../docs/architecture/retail-tower-operating-model.md)

---

## Context

Reporting and analytics are a supporting concern, not the platform's primary
identity (Constitution §Analytics and Data Pipeline Standards). Early reporting
needs are well served by API queries against the OLTP database. There is pressure
to stand up a dedicated analytics repository (warehouse, dbt, orchestration)
prematurely. This ADR records that **Analytics v1 is a lightweight backend module
in Data-Pulse-2**, and a separate `Retail-Tower-Analytics` repository is created
only when reporting genuinely outgrows API queries into warehouse-class
workloads.

This ADR is documentation only.

---

## Decisions

### D1. Analytics v1 is a backend module (API-query reporting)

Lightweight reporting that can be served by queries against the existing database
lives as a module in Data-Pulse-2, exposed via analytics APIs v1. Tenant
isolation is preserved end-to-end (§Analytics standards, §II).

### D2. Warehouse-class analytics triggers a repository split

A `Retail-Tower-Analytics` repository is created only when reporting moves into a
warehouse, dbt, ClickHouse, Dagster, heavy pipelines, forecasting, or scheduled
analytical workloads — i.e. when the **data-lifecycle** boundary (warehouse ≠
OLTP) and often the **deployment** boundary (scheduled pipelines) are clearly
met per [future-repo-split-criteria.md](../../../docs/architecture/future-repo-split-criteria.md).

### D3. Constitution analytics standards apply from day one

Even as a module, analytics follows the §Analytics and Data Pipeline Standards:
`staging → intermediate → marts` layering, naming conventions, materialization
defaults, lineage artifacts for big DAGs (`docs/lineage/`), grain-key tests, and
tenant scoping.

| Alternative considered | Ruled out because |
|---|---|
| Dedicated analytics repo now | No warehouse/pipeline lifecycle exists yet; splitting early adds orchestration and a cross-repo data contract with no benefit. |
| Analytics queries embedded ad hoc in UI | Bypasses backend authority and tenant-scoping guarantees (§III, §II). |
| Skip the layering standards until "later" | Retrofitting layering/lineage onto a grown module is costly; standards are cheap to honor from the start. |

---

## Consequences

- Reporting ships quickly as a module without standing up data infrastructure.
- The migration path to a warehouse is explicit and criteria-gated, not a
  surprise rewrite.
- **Tradeoff**: API-query reporting may not scale to heavy analytical workloads;
  accepted because the split criteria define exactly when to graduate.
- Honoring the analytics standards now keeps a future extraction mechanical.

---

## Rejected alternatives

- **Analytics repo now** — rejected (D2 table): no lifecycle boundary yet.
- **Ad hoc UI-embedded queries** — rejected (D3 table): bypasses backend
  authority and tenant scoping.
- **Defer the layering standards** — rejected (D3 table): expensive retrofit.

---

## Hard out-of-scope

- Implementing any analytics model, pipeline, or warehouse.
- Selecting warehouse/orchestration technology.

---

## Constitution Alignment

| Principle | Relationship |
|---|---|
| III. Backend Authority & Data Integrity | strengthened — analytics reads authoritative backend data |
| VIII. Reproducible & Versioned Releases | strengthened — criteria-gated, mechanical future split |
| §Analytics and Data Pipeline Standards | restated and applied to the v1 module |
| II. Multi-Tenant SaaS by Default | strengthened — tenant scoping preserved end-to-end |

No principle tension.

---

## Open Questions

1. What metric/volume threshold concretely signals the warehouse split? (Refine
   when Analytics v1 usage data exists.)

---

## Follow-up work

- An implementation spec for Analytics v1 APIs when prioritized.
- Define the warehouse split threshold against real usage; revisit
  [future-repo-split-criteria.md](../../../docs/architecture/future-repo-split-criteria.md).

---

## References

- [docs/architecture/future-repo-split-criteria.md](../../../docs/architecture/future-repo-split-criteria.md)
- [Constitution §Analytics and Data Pipeline Standards, §II, §III, §VIII](../constitution.md)
- [docs/architecture/product-capability-map.md](../../../docs/architecture/product-capability-map.md)
