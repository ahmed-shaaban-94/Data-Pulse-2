# ADR 0008 — Split Retail-Tower-ERP-Next-Connector from Data-Pulse-2

**Status**: Accepted
**Date**: 2026-06-04
**Accepted**: 2026-06-04 by Ahmed Shaaban (owner) — after 012 (PR #476) merged
**Owner**: Ahmed Shaaban
**Constitution version**: v3.0.1
**Feature / Ref**: [specs/012-erpnext-connector-contracts](../../../specs/012-erpnext-connector-contracts/spec.md); realises the [011 signed decisions](../../../specs/011-erpnext-pos-reference-and-integration-foundation/spec.md); frames the connector as the **concrete ERPNext instance** of the `Retail-Tower-Integrations` candidate in [docs/architecture/future-repo-split-criteria.md](../../../docs/architecture/future-repo-split-criteria.md) (additive — the umbrella candidate is preserved, not superseded)

---

## Context

The 011 foundation established ERPNext as the reference ERP and fixed the
integration boundary: there is exactly **one** path to ERPNext — **Data-Pulse-2 →
connector → ERPNext** — and POS-Pulse / Retail-Tower-Console never call ERPNext
directly. 012 specifies the **DP2 ↔ connector contract** (a pull/feed, bidirectional
surface realising the signed posting decision).

[future-repo-split-criteria.md](../../../docs/architecture/future-repo-split-criteria.md)
already named a **`Retail-Tower-Integrations`** candidate for "ERP/accounting
connectors", to be created only when a boundary test is met, via an ADR. This ADR
is that step for the ERPNext case: it proposes creating the connector repo because
a boundary test is now concretely met.

This ADR is documentation only. It **proposes**; it does not create the repository.

---

## Decisions

### D1. The ERPNext connector is the concrete `Retail-Tower-Integrations` instance

`Retail-Tower-ERP-Next-Connector` is the ERPNext realization of the
`Retail-Tower-Integrations` split candidate. There is one candidate concept, not
two overlapping ones (the repo name MAY be finalized here).

### D2. The boundary tests are met (security + team ownership)

- **Security boundary** — the connector holds **all** ERPNext credentials and is
  the only component that egresses to ERPNext. This is an isolation/blast-radius
  boundary a Data-Pulse-2 module cannot provide (DP2 deliberately holds **no**
  ERPNext credentials and makes **no** outbound HTTP calls — 012 §4,
  connector-lifecycle §1).
- **Team ownership** — the connector carries its own roadmap and the **ERPNext
  version upgrade cadence** (the version-pin decision makes the connector absorb
  ERPNext breaking changes), distinct from the DP2 backend roadmap.

The remaining tests (deployment, data lifecycle) reinforce but are not required:
the connector also deploys on a self-hosted, ERPNext-pinned cadence (version-pin
decision).

### D3. Contract surface = the 012 pull/feed contract

The DP2 ↔ connector boundary is the **versioned, bidirectional pull/feed
contract** specified in 012 (`contract-obligations.md`): DP2 exposes a pending-
postings feed; the connector pulls, posts to ERPNext, and ACKs outcomes back. The
contract is insulated from ERPNext version churn (it speaks Retail-Tower terms,
not ERPNext doctype fields).

### D4. Data ownership

- **Connector owns**: ERPNext credentials, ERPNext-facing mapping/state, and the
  custom Frappe app (including the ETA submission adapter, gated by 016).
- **Data-Pulse-2 owns**: the sale fact (008), the pending-postings feed, and the
  **DLQ + reconciliation state** (017 surfaces it). DP2 remains the source of
  truth; ERPNext owns the GL.

### D5. Process — accept before create

Per the split-criteria "process for a split": this ADR is **Accepted**
(2026-06-04, after 012 / PR #476 merged). The `Retail-Tower-ERP-Next-Connector`
repo is therefore authorized to be created and built against the 012 contract,
preserving the OpenAPI contract boundary with DP2. The repo is **not created by
this ADR** — acceptance authorizes the creation; the actual build proceeds via
the `[GATED]` 012-CONTRACT OpenAPI slice + the connector repo work. Any DP2-side
prototyping before the contract lands stays a backend module (never direct
ERPNext calls from POS-Pulse or Console).

---

## Consequences

- **Positive**: ERPNext credentials isolated to one repo; DP2 stays inbound-only;
  ERPNext version churn is contained behind the connector; the contract boundary
  keeps DP2 and the connector independently evolvable.
- **Cost**: a new repo to operate + the DP2 ↔ connector contract to version and
  keep green (contract tests).
- **Forecloses**: building ERPNext integration as an in-DP2 module long-term, and
  any direct POS-Pulse/Console → ERPNext path.

---

## Alternatives considered

- **Keep the connector as a DP2 module** — rejected: it would put ERPNext
  credentials and outbound egress inside the DP2 backend (blast radius), and
  couple the ERPNext upgrade cadence to DP2 releases.
- **A generic `Retail-Tower-Integrations` repo now** — deferred: only the ERPNext
  connector is concrete today; a generic integrations repo can subsume it later if
  more connectors appear. Naming this one specifically avoids speculative scope.
