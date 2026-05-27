# ADR 0004 — POS Offline / Sync Boundary

**Status**: Proposed
**Date**: 2026-05-27
**Owner**: Ahmed Shaaban
**Constitution version**: v3.0.0
**Feature / Ref**: [specs/005-pos-catalog-sync-reconciliation](../../../specs/005-pos-catalog-sync-reconciliation/spec.md); architecture operating model

---

## Context

The POS terminal must keep selling when the network is down, then reconcile with
the backend when it returns. This raises the question of *where the boundary sits*
between offline-first terminal behavior and authoritative backend state. The
Constitution requires backend authority over domain truth (§III), all POS↔backend
communication through versioned authenticated contracts (§IV, §"The trust
boundary"), and tenant isolation end-to-end (§II). Spec 005 (POS Catalog Sync &
Unknown Item Reconciliation) defines the sync surface. This ADR records the
division: POS-Pulse owns local-first behavior; Data-Pulse-2 owns the
authoritative record and the sync contract.

This ADR is documentation only.

---

## Decisions

### D1. POS-Pulse owns offline-first behavior

The offline queue, local SQLite state, local cart/tender/receipt flow, and the
sync client live in POS-Pulse. The terminal can complete a sale offline and
enqueue it for later sync.

### D2. Data-Pulse-2 owns the authoritative record and the sync contract

The backend is the source of truth for catalog, pricing, inventory, and sales.
Sync happens only through the versioned OpenAPI sync APIs. Reconciliation logic
(including unknown-item handling, specs 005/006) is decided in the backend, not
on the terminal.

### D3. Idempotency and tenant scope are enforced at the backend edge

Offline-then-synced operations carry idempotency keys / external IDs so replays
are safe (§XI), and every synced operation resolves to a tenant context at the
auth layer (§II). The terminal proposes; the backend authoritatively accepts,
deduplicates, and reconciles.

| Alternative considered | Ruled out because |
|---|---|
| Terminal treated as authoritative until sync | Violates §III backend authority and risks divergent truth across terminals. |
| Direct DB sync from terminal | Violates §"The trust boundary" (no direct DB access). |
| No idempotency on synced ops | Network retries would double-apply sales; violates §XI. |

---

## Consequences

- Sales survive network outages; the backend remains the single reconciled truth.
- The boundary is the OpenAPI sync contract — testable and versioned.
- **Tradeoff**: reconciliation conflicts (e.g. price changed while offline,
  unknown items) must be designed for explicitly; deferred to specs 005/006.
- POS-Pulse facts here are **unverified** (sibling repo not inspected); the
  backend-side contract is the authoritative anchor.

---

## Rejected alternatives

- **Terminal-authoritative-until-sync** — rejected (D3 table): divergent truth.
- **Direct DB sync** — rejected (D3 table): trust-boundary violation.
- **Sync without idempotency** — rejected (D3 table): double-application risk.

---

## Hard out-of-scope

- Implementing offline queue, sync client, reconciliation, or unknown-item flows.
- Defining the concrete sync OpenAPI endpoints (owned by spec 005).

---

## Constitution Alignment

| Principle | Relationship |
|---|---|
| III. Backend Authority & Data Integrity | strengthened — backend stays authoritative |
| II. Multi-Tenant SaaS by Default | strengthened — synced ops resolve a tenant context |
| XI. Idempotency & External IDs | strengthened — safe replay of synced operations |
| XII. Authorization & Object Safety | strengthened |

No principle tension.

---

## Open Questions

1. Conflict-resolution policy for offline price/catalog drift — owned by spec 005.

---

## Follow-up work

- Spec 005 defines the sync endpoints and reconciliation policy.
- Verify the POS-Pulse offline/sync-client boundary against the actual repo when
  accessible.

---

## References

- [specs/005-pos-catalog-sync-reconciliation/spec.md](../../../specs/005-pos-catalog-sync-reconciliation/spec.md)
- [specs/006-unknown-items-review-queue/spec.md](../../../specs/006-unknown-items-review-queue/spec.md)
- [Constitution §II, §III, §IV, §XI, §"The trust boundary"](../constitution.md)
- [docs/architecture/repo-boundaries.md](../../../docs/architecture/repo-boundaries.md)
