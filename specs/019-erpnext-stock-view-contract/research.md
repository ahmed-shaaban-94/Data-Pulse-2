# Phase 0 Research: ERPNext live stock-view (Bin) read contract

**Feature ID**: 019
**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Constitution**: v3.0.1
**Date**: 2026-06-07

Each decision below resolves an unknown surfaced by the spec. All are grounded in
the shipped 012 contract (`posting-feed.yaml`), the signed 014 stock-impact
decision + 014 data-model, the 017 reconciliation processor, and the 018 connector
identity.

---

## R1 — HTTP direction: connector is client, DP2 is server

**Decision**: The connector is the HTTP client; DP2 is the HTTP server and makes NO
outbound HTTP. DP2 EXPOSES the endpoints; the connector CALLS them. Bin data flows
connector→DP2, connector-initiated.

**Rationale**: 012's `posting-feed.yaml` states the invariant flatly — *"DP2 stays
the source of truth and makes NO outbound HTTP calls — it EXPOSES these endpoints,
the connector CALLS them."* "Provider of data" (the connector, semantically) is not
"HTTP server"; conflating them is the trap that would tempt a DP2→connector pull,
which is impossible under the invariant.

**Alternatives rejected**:
- *DP2 pulls Bin from a connector-hosted endpoint* — violates the no-outbound-HTTP
  invariant; would require DP2 to hold connector network credentials and egress.
- *A message bus / webhook from ERPNext directly to DP2* — bypasses the connector
  trust boundary (ADR 0008); ERPNext must never talk to DP2 directly.

---

## R2 — Interaction shape: pull-request + report (mirror 012), not unsolicited push

**Decision**: DP2 exposes a **feed** the connector pulls to learn which `(tenant,
store)` bin views are wanted (`binViewPullRequests`, mirroring `connectorPullPostings`),
and a **report** endpoint the connector POSTs the live Bin snapshot to
(`binViewReportSnapshot`, mirroring `connectorAckOutcome`).

**Rationale**: 014 specifies the Bin view is *"fetched on-demand by 017 at reconcile
time."* A request/report is genuinely on-demand and run-correlated. A free-running
unsolicited push forces DP2 to hold a "latest snapshot," which slides toward the
standing Bin mirror that 014 OQ-1 forbids. The pull/report pair is also symmetric
with the already-shipped 012 idiom, minimizing connector-side and DP2-side novelty.

**Alternatives rejected**:
- *Unsolicited connector push of bin snapshots on a timer* — produces a standing
  latest-snapshot (mirror drift, OQ-1 violation) and is not run-correlated.
- *A single combined request-response (connector POSTs a "read this warehouse now"
  and blocks for the answer)* — couples a slow ERPNext read into a synchronous DP2
  request and inverts the direction (DP2 would be waiting on ERPNext); rejected.

---

## R3 — No standing Bin mirror: run-scoped evidence only

**Decision**: 019 adds NO new persisted table/column for Bin quantities. The
reported snapshot is run-scoped evidence; its point-in-time per-item values may be
recorded in the existing 017 `erpnext_reconciliation_result.detail`
(`{ dp2_on_hand, erpnext_bin }`), which is already its behavior, as audit of what
was compared — never as an authoritative DP2 stock balance.

**Rationale**: The signed 014 stock-impact decision (OQ-1) explicitly rejects a
standing DP2 copy of ERPNext stock as the "read-down look-alike." The 017 processor
already persists `erpnext_bin` into `result.detail` at reconcile time; that is a
point-in-time audit row, not a synced mirror, and is the correct home. Keeping 019
off `packages/db` also keeps it free of a migration gate.

**Alternatives rejected**:
- *A standing `erpnext_bin_balance` table refreshed on every report* — the exact
  OQ-1-forbidden mirror.
- *Caching the latest snapshot in Redis keyed by `(tenant, store)`* — still a
  standing latest-state authority-by-the-back-door; §III forbids cache-as-truth and
  OQ-1 forbids the mirror regardless of store.

---

## R4 — Item keying: `erpnextItemRef` on the wire, DP2-side translation to `tenant_product_ref`

**Decision**: The connector reports items by `erpnextItemRef` (doctype fixed to
`Item` + opaque `name`, mirroring 012's `ErpnextItemRef`). DP2 translates each
`erpnextItemRef` to a `tenant_product_ref` via the confirmed 013 `erpnext_item_map`,
DP2-side, behind the contract.

**Rationale**: 012 O-6 (version-independence) requires the connector to stay
ignorant of DP2 product IDs; it speaks ERPNext terms. The 017 `ErpnextBinView` seam
keys its returned Map by `tenant_product_ref` (`fetchBinView → Map<tenant_product_ref,
qty>`), so the `erpnextItemRef → tenant_product_ref` translation is unavoidably a
DP2-side step. An `erpnextItemRef` with no confirmed 013 map cannot translate and
surfaces as `erpnext_only` (the 017 run's existing behavior for an unmatched Bin
entry).

**Alternatives rejected**:
- *Connector reports by `tenant_product_ref`* — leaks DP2 internal IDs into the
  connector (O-6 violation) and assumes the connector knows DP2's product identity.
- *DP2 pushes the item-map to the connector so it can translate* — re-exports the
  013 mapping outside DP2; the mapping authority stays DP2 (013 §IX).

---

## R5 — Auth: reuse the 018 machine `connectorBearer`, no new primitive

**Decision**: Both endpoints use the opaque, revocable, tenant-scoped machine
`connectorBearer` scheme (018 identity / `ConnectorAuthGuard`), namespaced under
`/api/connector/v1/erpnext`. No POS `clerkJwt`, no human `cookieAuth`, no new auth
primitive.

**Rationale**: This is the connector trust boundary; 012 + 018 already established
the machine bearer + tightened `ConnectorAuthGuard` (registration-link usability
predicate, identity attach, non-disclosing 401). 019 is another connector-facing
surface and reuses it verbatim. A revoked/disabled connector → generic 401.

**Alternatives rejected**:
- *A read-only scope on the existing token* — the contract is on a single machine
  principal; scoping is a future refinement, not a new primitive, and not needed
  for v1 (the surface is read/report only by construction).

---

## R6 — Idempotency on the report: reuse `IdempotencyInterceptor`

**Decision**: `binViewReportSnapshot` REQUIRES an `Idempotency-Key` header. Same
key + same body → idempotent replay of the prior recorded response; same key +
materially different body → `409 idempotency_key_conflict`. Reuses the existing
`IdempotencyInterceptor` keyed on `(method, route, clientId = connector principal,
key)`. The feed pull is idempotent on its `since` cursor (re-requesting the same
cursor yields the same logical work set), per 012.

**Rationale**: At-least-once delivery is the network's promise (§XI). 008/012
already manufacture exactly-once via this interceptor; 019 reuses it, introducing no
new idempotency mechanism. A duplicate snapshot report must not double-record.

**Alternatives rejected**:
- *Natural idempotency on `(requestRef, readAt)`* — fragile (the connector might
  re-read and report a slightly different `readAt` for a retry of the same logical
  read); the explicit `Idempotency-Key` is the established contract.

---

## R7 — Tenant isolation + staleness: 012 semantics verbatim

**Decision**: Scope resolves from the connector principal only; query/body scope is
ignored or rejected (strict DTOs). Cross-tenant / out-of-scope `requestRef` or
cursor → non-disclosing `not_found` (404-class), identical to absent. A stale /
unservable feed `since` cursor → `snapshot_required` (409, re-baseline). Cross-tenant
sweep + RLS-bypass posture asserted in the conformance/integration tests.

**Rationale**: Identical to `posting-feed.yaml`'s `Since`/`NotFound`/`SnapshotRequired`
semantics. §II/§XII demand non-disclosure; reusing the 012 vocabulary keeps the
connector's error handling uniform across both contracts.

**Alternatives rejected**:
- *403 for cross-tenant* — leaks existence; §II reserves 403 for in-tenant role
  gates only.

---

## R8 — The 017 run-lifecycle change is a separate future slice

**Decision**: 019 authors the contract (+ the DP2-facing feed/report surface in a
later slice). The 017 run-lifecycle rewire — today `fetchBinView` is synchronous
over `EMPTY_BIN_VIEW` and the run completes in one transaction; a connector-fed view
is request→await→report, so the run can no longer complete synchronously — is named
as a SEPARATE future **017-rewiring** slice (precedent: `017-RECON-WIRING`) and is
OUT OF SCOPE for 019.

**Rationale**: This is the single biggest downstream consequence of a connector-fed
view, but it is a worker-run-lifecycle redesign, not a wire-contract concern.
Conflating it into 019 violates thin-slice discipline and the no-implement boundary
of this planning pass. The contract can be approved and pinned (unblocking the
connector repo) before the run rewire is built — exactly as 012 shipped the contract
before the 015/connector feed runtime.

**Alternatives rejected**:
- *Bundle the rewire into 019* — too broad; touches `worker.module.ts`, the
  reconciliation processor lifecycle, and likely a new outbox event-type (gated),
  none of which a contract spec should own.

---

## R9 — Conformance test load convention (non-recursive loader)

**Decision**: The conformance spec loads the new YAML with an explicit `dir`
(`apps/api/test/erpnext-connector/contract/stock-view.contract.spec.ts`), because
the production `loadOpenApiContracts` helper (`apps/api/src/openapi/loader.ts`) is
non-recursive (`readdirSync` with no recursive flag) — exactly as
`posting-feed.contract.spec.ts`, `catalog/read-down.yaml`, and `pos-sales/sales.yaml`
are loaded.

**Rationale**: Documented in `posting-feed.yaml` itself and in
`reference_008_migration_gotchas` (non-recursive OpenAPI loader). Following the
established convention avoids the loader silently skipping the nested file.

**Alternatives rejected**:
- *Place the YAML at the openapi root to be auto-discovered* — breaks the
  `erpnext-connector/` grouping 012 established and the namespace hygiene.

---

## Open prerequisite (not an unknown — an external gate)

Live cross-system validation (the connector actually reading a real ERPNext Bin and
reporting it to DP2) requires the connector repo's live Bin reader + a staging
ERPNext. This is the same gate 017 carried as the `017-STOCK-VIEW-CONTRACT`
deferral; 019 authors the DP2-facing contract so the connector repo can build
against a pinned surface. It is a gate on *exercising* the contract, not on
*authoring* it.
