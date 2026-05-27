# Retail Tower OS — Repository Boundaries

**Status**: Proposed
**Date**: 2026-05-27
**Owner**: Ahmed Shaaban
**Constitution version**: v3.0.0
**Scope**: Documentation only. Defines what each repository owns and explicitly
does **not** own.

> Read with [retail-tower-operating-model.md](retail-tower-operating-model.md),
> [feature-placement-rules.md](feature-placement-rules.md), and the live
> backend boundary in the [Constitution §Repository Scope](../../.specify/memory/constitution.md)
> and [../ARCHITECTURE.md](../ARCHITECTURE.md). This document extends those; it
> does not contradict them.

> **Verification note.** Data-Pulse-2 boundaries below are evidence-backed
> (Constitution, README, specs `001`–`006`). POS-Pulse and Retail-Tower-Console
> boundaries are the *intended* division of responsibility and are marked
> **(unverified — sibling repo not inspected)** because GitHub access in this
> session is restricted to `data-pulse-2`.

---

## Data-Pulse-2 — backend, source of truth

### Owns

- Backend APIs (the SaaS HTTP surface).
- Database schema (PostgreSQL, Drizzle, explicit SQL migrations).
- Tenancy, security, and RBAC (RLS, auth tokens, tenant/store context).
- OpenAPI contracts (`packages/contracts/openapi/`) — the integration source of record.
- Workers and background jobs (BullMQ).
- Outbox and event model.
- Billing backend.
- Usage metering.
- Device registry backend.
- Support APIs.
- Analytics APIs v1 (lightweight, API-query reporting).

### Does not own

- Cashier UI (POS-Pulse).
- Admin dashboard UI (Retail-Tower-Console).
- POS hardware control (POS-Pulse).
- Heavy warehouse pipelines — *unless analytics is still lightweight*, in which
  case it remains a backend module (see [ADR 0006](../../.specify/memory/decisions/0006-analytics-module-before-analytics-repo.md)).

---

## POS-Pulse — cashier terminal *(unverified — sibling repo not inspected)*

### Owns

- Cashier UI. *(unverified)*
- Cart / tender / receipt UX. *(unverified)*
- Terminal pairing. *(unverified)*
- Local SQLite state. *(unverified)*
- Offline queue. *(unverified)*
- Terminal sync status. *(unverified)*
- Receipt / printer / cash-drawer integration. *(unverified)*
- Terminal health client. *(unverified)*

### Does not own

- Authoritative catalog (Data-Pulse-2). *(unverified)*
- Tenant billing (Data-Pulse-2). *(unverified)*
- Database schema (Data-Pulse-2). *(unverified)*
- OpenAPI source (Data-Pulse-2). *(unverified)*
- Backend authorization truth (Data-Pulse-2). *(unverified)*

> Backend-side anchor (verified): the Constitution §"The trust boundary" requires
> all POS↔backend communication to flow through documented, versioned,
> authenticated API contracts — no direct DB access, shared filesystems, or
> undocumented endpoints.

---

## Retail-Tower-Console — admin / management UI *(unverified — sibling repo not inspected)*

### Owns

- Admin UI. *(unverified)*
- Tenant / store / user management UI. *(unverified)*
- Catalog UI. *(unverified)*
- Inventory UI. *(unverified)*
- Billing UI. *(unverified)*
- Support console UI. *(unverified)*
- Terminal health dashboard. *(unverified)*
- Reports UI. *(unverified)*
- Demo tenant management UI. *(unverified)*

### Does not own

- Backend business logic (Data-Pulse-2). *(unverified)*
- Database schema (Data-Pulse-2). *(unverified)*
- Workers (Data-Pulse-2). *(unverified)*
- OpenAPI source (Data-Pulse-2). *(unverified)*
- POS hardware control (POS-Pulse). *(unverified)*

---

## Boundary at a glance

| Concern | Data-Pulse-2 | POS-Pulse | Retail-Tower-Console |
|---|---|---|---|
| Source of truth (catalog, inventory, sales, billing) | ✅ owns | ❌ consumes | ❌ consumes |
| Authorization & tenancy truth | ✅ owns | ❌ consumes | ❌ consumes |
| OpenAPI contract source | ✅ owns | ❌ consumes | ❌ consumes |
| Offline / local-first behavior | ❌ | ✅ owns | ❌ |
| Hardware (printer / drawer) | ❌ | ✅ owns | ❌ |
| Admin / management screens | ❌ | ❌ | ✅ owns |
| Cashier screens | ❌ | ✅ owns | ❌ |

The shared invariant: **truth flows out of Data-Pulse-2 through versioned OpenAPI
contracts; UIs and terminals consume it and never bypass it.**
