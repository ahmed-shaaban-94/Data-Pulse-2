# Retail Tower OS — Product Capability Map

**Status**: Proposed
**Date**: 2026-05-27
**Owner**: Ahmed Shaaban
**Constitution version**: v3.0.0
**Scope**: Documentation only. A snapshot of where each capability lives, who
owns it, and the condition under which it would split into its own repository.

> Read with [retail-tower-operating-model.md](retail-tower-operating-model.md)
> (defines the Type taxonomy and Production/Business terms),
> [repo-boundaries.md](repo-boundaries.md), and
> [future-repo-split-criteria.md](future-repo-split-criteria.md).

---

## Legend

- **Type** — `Production` (must run the store safely) · `Business` (monetizes/
  administers the SaaS) · `Domain` (retail functionality, neither plumbing nor
  commercial) · `Future` (not started, explicitly deferred).
- **Status** — `existing` (shipped on main) · `partial` (in flight / first slice
  landed) · `planned` (specced, not built) · `future` (deferred) · `unknown`
  (not verifiable from Data-Pulse-2).
- **POS involvement** — whether POS-Pulse participates as a client/consumer.
- Owner columns name the *repository* that owns the capability, not a person.
- Status is grounded in Data-Pulse-2 specs `001`–`006` and the Constitution
  §Repository Scope. Sibling-repo facts are **unverified** where noted.

---

## Capability matrix

| Capability | Type | Backend owner | UI owner | POS involvement | Status | Notes / split condition |
|---|---|---|---|---|---|---|
| SaaS core | Production | Data-Pulse-2 | Retail-Tower-Console | Indirect (auth/tenant context) | existing | Foundation (spec 001) shipped. Never splits — it is the core. |
| Auth / RBAC | Production | Data-Pulse-2 | Retail-Tower-Console | Yes (token + tenant context) | existing | argon2id + opaque tokens + RLS (spec 001). Stays in backend; security truth is non-negotiable (§III, §XII). |
| Tenant lifecycle | Production | Data-Pulse-2 | Retail-Tower-Console | Indirect | partial | Tenant/store/membership exist (001); full lifecycle (provisioning/suspend/offboard) not built. Module in backend. |
| Feature flags | Production | Data-Pulse-2 | Retail-Tower-Console | Maybe (flag read) | planned | Module in backend (backend-evaluated). Split only if a dedicated flag service gains independent lifecycle. |
| Catalog | Production | Data-Pulse-2 | Retail-Tower-Console | Yes (sync target) | existing | Source of truth (spec 003 complete). Stays in backend (§Source-of-Truth). |
| Unknown item reconciliation | Domain | Data-Pulse-2 | Retail-Tower-Console | Yes (raises unknowns) | planned | Specs 005/006. Backend owns reconciliation logic + review queue API; Console renders the queue. Module. |
| Inventory | Production | Data-Pulse-2 | Retail-Tower-Console | Yes (stock reads/movements) | planned | Source of truth in backend (§Repository Scope). Module; no split foreseen. |
| Sales backend | Production | Data-Pulse-2 | Retail-Tower-Console | Yes (sale submission) | planned | Central sales records are source of truth. Module in backend. |
| POS sale flow | Production | Data-Pulse-2 (sync APIs) | POS-Pulse | Yes (owns the flow) | planned | Terminal-side flow owned by POS-Pulse; authoritative record in backend via sync APIs. Already cross-repo by design. |
| Offline sync | Production | Data-Pulse-2 (sync contract) | POS-Pulse | Yes (owns client) | partial | Sync contract/spec 005 in backend; offline queue + client in POS-Pulse. Boundary is the OpenAPI contract (ADR 0004). |
| Device registry | Future | Data-Pulse-2 | Retail-Tower-Console | Yes (device pairing) | partial | `devices` table + hashed tokens landed via spec 002 PR-3; full registry deferred. Backend module; not a repo. |
| Terminal health | Domain | Data-Pulse-2 (ingest API) | Retail-Tower-Console (dashboard) | Yes (reports health) | planned | Client reporter in POS-Pulse; ingest + dashboard data in backend; dashboard UI in Console. Module. |
| Billing / subscriptions | Business | Data-Pulse-2 | Retail-Tower-Console | No | planned | Backend owns billing truth (§Repository Scope, ADR 0005). Module; do not split (tenant/PII coupling). |
| Usage metering | Business | Data-Pulse-2 | Retail-Tower-Console | Indirect (usage events) | planned | Lives with billing in backend (ADR 0005). Module. |
| Support console | Business | Data-Pulse-2 (support APIs) | Retail-Tower-Console | No | planned | Support APIs in backend; console UI in Console. Cross-tenant actions must be audited (§II). Module. |
| Demo / sandbox tenant | Business | Data-Pulse-2 | Retail-Tower-Console | Maybe | planned | A tenant *configuration*, not a feature needing a repo. Backend module + Console management UI. |
| Audit logs / search | Production | Data-Pulse-2 | Retail-Tower-Console | Indirect | partial | Audit pipeline foundation shipped (001); search UI in Console. Backend module (§XIII). Never splits. |
| Event model / outbox | Production | Data-Pulse-2 | n/a | Indirect | partial | First outbox slice shipped (001) + production-readiness work (004). Backend-internal; no UI, no repo split. |
| Analytics v1 | Domain | Data-Pulse-2 | Retail-Tower-Console | No | planned | Lightweight API-query reporting stays a backend module (ADR 0006). Split → `Retail-Tower-Analytics` only on warehouse pressure. |
| Heavy analytics / warehouse | Future | (future repo) | Retail-Tower-Console | No | future | Deferred. Becomes `Retail-Tower-Analytics` when dbt/ClickHouse/Dagster/forecasting pipelines appear (ADR 0006, split-criteria). |
| Integrations / webhooks | Future | Data-Pulse-2 | Retail-Tower-Console | No | future | Start as a backend module; extract `Retail-Tower-Integrations` when connector lifecycle/DLQ/external creds become substantial. |
| Infra / deployment | Production | Data-Pulse-2 | n/a | No | partial | Config lives in backend today (§Repository Scope). Extract `Retail-Tower-Infra` only on independent deploy/secrets/DR lifecycle (ADR 0007). |
| Design system | Domain | n/a | Retail-Tower-Console (+ POS-Pulse consumer) | Maybe (shared UI) | future | Start as a module/package inside Console. Split to a shared package/repo only when POS-Pulse + Console genuinely co-consume it. |
| Generated API clients | Production | Data-Pulse-2 (OpenAPI source) | consumed by Console & POS-Pulse | Yes (consumer) | partial | Generated *from* the OpenAPI contract of record (ADR 0003). Distribution as a package; source never leaves the backend. |

---

## How to use this map

- **Adding a capability?** Find its closest row, copy the Type/owner pattern, and
  apply [feature-placement-rules.md](feature-placement-rules.md). If it has no
  row, it is almost certainly a *module* in the owning repo.
- **Thinking about a new repo?** The "split condition" column points at the
  governing criteria in [future-repo-split-criteria.md](future-repo-split-criteria.md).
  No split without a matching boundary and an ADR.
- **Status drift.** This is a point-in-time snapshot (2026-05-27). The
  authoritative live state is the active spec's `execution-map.yaml` /
  `wave-status.md` and GitHub — reconcile against those before acting.
