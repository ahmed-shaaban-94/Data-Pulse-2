# Decision Record: ERPNext/Frappe Version Pin & Upgrade Policy

**Decision ID**: 011-DR-VERSION-PIN
**Feature**: 011-erpnext-pos-reference-and-integration-foundation
**Status**: **SIGNED**
**Gates**: specs **012**, **017** (per spec §9)
**Owner / signer**: Ahmed Shaaban
**Created**: 2026-06-03
**Signed**: 2026-06-03

> **SIGNED.** A decision has been recorded below. The specs this record gates
> (012/017) may proceed through their own Spec-Kit planning chains and Agent OS
> gates, consistent with this decision. Any deviation from it is a
> STOP-and-raise condition, not a silent override.

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

## Decision

Retail Tower will use a **self-hosted, pinned** ERPNext/Frappe deployment, talk
to ERPNext over its **stable REST resource API on submitted doctypes** (plus a
thin custom Frappe app for bespoke/ETA needs), and **never advance the pin
without the connector's contract tests passing**. **The exact supported major
version is NOT hard-locked by this record** — it is confirmed in **012**. Each
numbered item answers the correspondingly-numbered sub-question above.

1. **Pinned version — baseline v15, final major confirmed in 012.** Retail Tower
   will use a **self-hosted, pinned** ERPNext/Frappe deployment. The initial
   **reference-lab baseline MAY start with ERPNext/Frappe v15** for stability, but
   the **final supported major version and exact point releases MUST be confirmed
   in 012** after connector contract tests, staging-install validation, and
   compatibility checks. The connector absorbs ERPNext/Frappe breaking changes
   (item 5). Production upgrades remain **staging-first and gate-controlled**
   (item 4). *(Rationale: by mid-2026 ERPNext/Frappe v16 exists alongside v15, so
   the major version is deliberately left to 012's validation rather than
   hard-locked here.)*

2. **Hosting — self-hosted, version-pinned.** ERPNext is **self-hosted** so the
   pin and the upgrade cadence are **under our control** (consistent with §VIII
   reproducible releases). Frappe Cloud is **rejected** for v1 because it would
   impose an upgrade cadence we do not control, which conflicts with the
   staging-first, pin-then-test-then-advance policy below.

3. **API surface — stable REST resource API on submitted doctypes + a thin
   custom Frappe app.** The connector depends on ERPNext's **documented REST
   resource API** for the submitted doctypes the posting/stock/tax decisions
   require (Sales Invoice, Payment Entry, Stock Ledger via the invoice, credit
   notes, Item, Warehouse). Anything bespoke (ETA submission glue, custom fields,
   correlation-ID storage) lives in a **thin custom Frappe app** in the connector
   repo, **not** in undocumented RPC calls against ERPNext internals. Custom
   doctype/field dependencies are declared in that app and versioned with it.

4. **Upgrade cadence & compatibility gate — advance only on green contract
   tests; owner-approved.** The pin is advanced **only after** the connector's
   **contract tests pass** against the candidate ERPNext major/point release.
   There is **no automatic upgrade**. Advancing the pin is an **owner-approved**
   decision (the same authority that signs this record), recorded as an update to
   this decision (or a successor record) so the reproducible-environment
   definition stays truthful.

5. **Breaking-change posture — the connector absorbs it.** When ERPNext makes a
   breaking change, the **connector** is responsible for absorbing it — via a
   **compatibility shim or a version-branch** in the connector / its custom
   Frappe app. The **DP2 ↔ connector contract MUST NOT break** to accommodate an
   ERPNext upgrade. The owner owns the upgrade decision; the connector team (when
   it exists, per the `Retail-Tower-Integrations` split) owns the implementation.

6. **Connector ↔ DP2 contract independence — confirmed.** The DP2 ↔ connector
   boundary is a **versioned OpenAPI contract** (defined in **012**) that is
   **insulated from ERPNext version churn** (§IV): an ERPNext upgrade changes the
   connector's *internal* ERPNext-facing code, never the DP2-facing contract.
   Any **new external dependency** (ERPNext SDK / Frappe client) introduced into a
   DP2 package remains a **separate `[GATED]` `package.json` decision** (standing
   rules) — it is **not** implied or pre-authorized by this record. The pinned
   ERPNext version is part of the connector's **reproducible-environment**
   definition (§VIII).

### Downstream obligations this decision imposes

- **012** (connector contracts): records the exact v15 point-release pin + the
  relied-upon doctype/API surface; defines the DP2 ↔ connector OpenAPI contract
  insulated from ERPNext churn; proposes the `Retail-Tower-ERP-Next-Connector`
  split ADR; any new dependency is a separate `[GATED]` decision.
- **017** (sync-ops/repair): its repair/reconciliation surface assumes the pinned
  v15 API surface; a pin advance re-runs the contract tests before 017 relies on
  new behaviour.

## Sign-off

| Field | Value |
|---|---|
| Status | **SIGNED** |
| Signer | Ahmed Shaaban |
| Date | 2026-06-03 |
