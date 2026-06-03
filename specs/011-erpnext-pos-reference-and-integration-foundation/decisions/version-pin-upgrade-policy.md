# Decision Record: ERPNext/Frappe Version Pin & Upgrade Policy

**Decision ID**: 011-DR-VERSION-PIN
**Feature**: 011-erpnext-pos-reference-and-integration-foundation
**Status**: **UNSIGNED — BLOCKS IMPLEMENTATION**
**Gates**: specs **012**, **017** (per spec §9)
**Owner / signer**: Ahmed Shaaban (unsigned)
**Created**: 2026-06-03

> **PLACEHOLDER.** This record is a *gate*, not a decision. **No spec it gates may
> begin implementation until this record is signed** (`Status: SIGNED` + dated owner
> sign-off). An agent dispatched to a gated spec MUST verify this record is `SIGNED`
> and STOP-and-report otherwise.

---

## Question to be decided

**Which ERPNext/Frappe version does the integration target, and what is the upgrade policy that keeps the connector contract stable across ERPNext releases?**

Sub-questions the signed decision MUST answer:

1. **Pinned version** — which ERPNext **major** (e.g. v14 / v15) and Frappe framework version is the integration built against? What is the exact pin (version + the doctype/API surface relied upon)?
2. **Hosting assumption** — self-hosted ERPNext vs Frappe Cloud? Does the hosting choice constrain the API surface or upgrade cadence?
3. **API surface contract** — which ERPNext APIs (REST resource, RPC method, custom Frappe app endpoints) are depended on, and are they stable across the pinned major? Custom doctype dependencies?
4. **Upgrade cadence & compatibility** — how often is the pin advanced? What is the compatibility test gate before adopting a new ERPNext major (the connector's contract tests must pass)?
5. **Breaking-change posture** — when ERPNext makes a breaking change, what is the connector's response (shim, version-branch, deferral)? Who owns the upgrade decision?
6. **Connector ↔ DP2 contract independence** — confirm the DP2 ↔ connector OpenAPI contract is insulated from ERPNext version churn (ERPNext upgrades MUST NOT force a DP2 contract break).

## Constraints any decision MUST respect

- The DP2 ↔ connector boundary is a versioned OpenAPI contract; ERPNext version churn must not leak through it (Constitution §IV).
- A new external dependency (ERPNext SDK / Frappe client) in any DP2 package is a separate `[GATED]` `package.json` decision (standing rules), not implied by this record.
- Reproducible releases (§VIII): the pinned ERPNext version is part of the reproducible-environment definition for the connector.

## Options under consideration (to be filled in when decided)

_(none recorded yet — this is a placeholder)_

## Decision

_(unsigned)_

## Sign-off

| Field | Value |
|---|---|
| Status | **UNSIGNED — BLOCKS IMPLEMENTATION** |
| Signer | _(pending)_ |
| Date | _(pending)_ |
