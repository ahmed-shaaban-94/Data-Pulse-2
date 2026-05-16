# POS Catalog Read-Model Direction

**Feature**: 003 — Catalog Foundation
**Document type**: Direction-only (documentation; no implementation)
**Clarification anchor**: [`Q12`](./spec.md#q12--future-pos-catalog-read-model)
**Spec section**: [§6.4 Resolved Catalog View](./spec.md#64-resolved-catalog-view-read-model)
**Plan sections**: [§2.1 (Q12 binding constraint)](./plan.md#21-clarifications-treated-as-binding-constraints) · [§3.4 (SaleLine Snapshot obligation)](./plan.md#34-future-saleline-snapshot-obligation-binding) · [§6.2 F-CAT-POS-SEAM](./plan.md#62-task-families-preview--to-be-expanded-by-speckittasks)
**Task**: T314
**Constitution**: v3.0.0 (especially §4 Contract-First POS Integration, §9 Source-of-Truth Model, §10 Retail Temporal Semantics)

---

## 1. Purpose

This document records the **direction** the Data-Pulse-2 platform intends to
take for the future POS-facing catalog read model. It exists to satisfy
clarification `Q12` from the Catalog Foundation spec, so that any later POS
sync feature inherits a known, owner-approved direction rather than
re-litigating the read-model shape from scratch.

This is a **documentation-only artifact**. It introduces no behavior, no
schema, no route, no controller, no worker, no queue, no SDK, no sync
implementation, no POS app code, and no dashboard work. No endpoint is
authored in this feature. No OpenAPI YAML is authored or referenced as a
contract surface in this feature.

---

## 2. Scope of this document

In scope:

- Recording **snapshot + delta** as the preferred future direction for the
  POS catalog read model.
- Recording **why** an online-only per-scan lookup is not the primary future
  direction.
- Recording the boundary rules that any future POS-facing read model must
  preserve (Constitution §4, §9, §10).
- Recording what is **explicitly deferred** to a future POS sync feature
  (snapshot signing, integrity, authentication, transport, conflict
  resolution, drift reconciliation).

Out of scope (no work introduced here):

- No route, controller, worker, queue, SDK, sync implementation, or POS app
  work.
- No OpenAPI YAML, no schema, no migration, no application source, no test
  code, no package or lockfile changes.
- No claim that any implementation exists. Nothing in this document should be
  read as describing shipped behavior.

---

## 3. Direction: snapshot + delta as the primary future POS path

The preferred future direction is a **snapshot + delta** read model:

- A POS terminal obtains a **catalog snapshot** scoped to its
  `(tenant_id, store_id)` representing the resolved store catalog
  (Tenant Catalog ⊕ Store Override, per spec §6.4) at a known reference
  point in time.
- Subsequent updates are applied as **deltas** layered on top of that
  snapshot, advancing the terminal's local catalog state forward in time
  without requiring it to re-download the full catalog.
- The terminal continues to operate on the most recent locally-applied state
  during connectivity loss; when connectivity is restored, outstanding
  deltas are caught up.

This direction follows directly from `Q12`'s resolution in the spec and from
Constitution §4 (contract-first, versioned, authenticated future POS
integration) and Constitution §10 (retail temporal semantics — POS must
behave predictably with respect to time, even offline).

A per-scan online lookup may exist later as an **online fallback** path, not
as the primary POS path. This document does not design that fallback; it
only records that the fallback role is the only role online lookup is
allowed to play.

---

## 4. Why online-only per-scan lookup is not the primary future direction

An online-only per-scan lookup path was considered and rejected as the
primary future direction for three reasons:

### 4.1 Latency

A per-scan lookup adds a network round-trip to every barcode/SKU resolution
on the POS. Even at low single-digit milliseconds of perceived latency, that
cost is paid on every line item of every sale across every terminal. Retail
checkout flows are latency-sensitive; cashier throughput and customer
experience both degrade under unpredictable per-scan network cost.

### 4.2 Offline resilience

Retail stores experience connectivity loss for reasons fully outside the
platform's control: ISP outages, in-store networking faults, scheduled
maintenance windows, mobile-network coverage gaps for field/popup POS
deployments. An online-only primary path means POS becomes non-functional
the moment connectivity drops. That is an unacceptable operational posture
for retail and is incompatible with the spec's framing of POS as a system
that must keep operating during connectivity loss (`Q12` rationale).

### 4.3 Predictability of per-scan cost

Per-scan online lookup makes the cost of a single scan a function of network
conditions, server load, and per-tenant traffic patterns. Snapshot + delta
shifts the cost from "per scan" to "per catalog change wave," which is far
more predictable and far easier to capacity-plan. Predictable cost also
makes the future POS sync feature easier to specify, test, and observe (see
spec §9 — `reconciliation_mismatch_rate` is meaningful only against a model
where the POS holds known state).

---

## 5. Boundaries this direction must preserve

Any future POS sync feature that implements snapshot + delta must preserve
the following boundaries. They are inherited from the constitution and from
the Catalog Foundation spec.

### 5.1 POS integrates only through documented APIs in future features

POS terminals integrate with the platform **only** through documented APIs
authored in future features. No POS terminal — and no POS application — may
discover catalog state through any side channel, undocumented surface, or
ad-hoc query. Constitution §4 requires future POS-facing surfaces to be
documented, versioned, authenticated, and idempotent where mutating. This
document does not author any such API surface; it only records that any
future surface must satisfy those rules.

### 5.2 POS must never access the SaaS database directly

The POS application is a separate repository and a separate runtime. It
**must never** open a connection to the SaaS database, run SQL against it,
or otherwise read or write catalog rows directly. This is a hard
constitutional rule (§4 Contract-First POS Integration) and applies whether
the read model is snapshot + delta, online per-scan, or any other shape. A
snapshot is produced by the platform and delivered through a documented,
authenticated future surface — it is never the result of POS reaching into
the platform's database.

### 5.3 Source-of-truth layers are preserved

Snapshot + delta is a **read** projection of the resolved store catalog
(Tenant Catalog ⊕ Store Override). It does not collapse the four
source-of-truth layers in spec §5. The Global Product Index remains
reference-only; the Tenant Catalog remains tenant truth; the Store Override
remains branch truth; the future SaleLine Snapshot remains invoice truth
(spec §5.4). A POS snapshot is not authoritative for any of them.

### 5.4 Past sale facts are immune

Snapshot + delta describes the current and future state of the resolved
catalog that POS reads. It must never be a mechanism by which catalog or
price changes silently rewrite past sale facts (Constitution §10, spec
§5.4, plan §3.4). SaleLine Snapshot capture at sale time remains the
mechanism that protects historical sale facts; the POS read model neither
replaces nor weakens it.

### 5.5 Tenant and store scoping

A POS snapshot is always scoped to a single `(tenant_id, store_id)` pair
established by the authenticated POS principal at request time per spec 002.
Body- or client-supplied `tenant_id` / `store_id` are not trusted
(Constitution §12; spec §10). Cross-tenant or cross-store snapshot requests
return a safe non-disclosing response per Constitution §2.

### 5.6 Observability hooks already named

Spec §9 names `reconciliation_mismatch_rate` and
`catalog_lookup_failure_rate` as future observability signals. Snapshot +
delta is the model those metrics assume. The metrics are named in spec §9;
emission lands with the future POS sync feature, not here.

---

## 6. What is deferred to a future POS sync feature

The following questions are **deferred**. They are not answered in this
document and they are not answered anywhere else in Catalog Foundation.
They must be answered as part of the future POS sync feature's own spec
and plan.

- **Snapshot signing, integrity, and authentication.** Whether the
  snapshot is signed (HMAC, detached asymmetric signature, or relies on
  transport-layer integrity), how the POS verifies it, and how snapshot
  authenticity is established are deferred. Plan §9 PQ-6 records this
  deferral; research.md PQ-6 records the same.
- **Snapshot format and transport.** Wire format, compression, chunking,
  transport protocol, and pagination are deferred.
- **Delta format and ordering.** How deltas are described, ordered,
  deduplicated, and applied is deferred.
- **Conflict resolution and drift detection.** How divergence between the
  POS-applied state and the platform-resolved state is detected, surfaced,
  and reconciled is deferred. Spec §9 names the metric;
  the mechanism is not designed here.
- **Online fallback shape.** If an online per-scan fallback is added later,
  its shape, authentication, idempotency posture, and behavior under
  partial connectivity are deferred to the future POS sync feature. It
  remains a fallback, not the primary path.
- **POS-side caching, persistence, and resync windows.** All POS-side
  concerns are owned by the POS app repository, not by this platform.

This document does not pre-decide any of the above. It only records the
direction in which they will be answered.

---

## 7. What this document does NOT do

To prevent future misreading:

- It does **not** author an endpoint. No endpoint is authored in this
  feature.
- It does **not** author or reference any OpenAPI YAML as a contract
  surface. No OpenAPI file is created, modified, or relied upon by this
  document.
- It does **not** introduce a route, controller, worker, queue, SDK, sync
  implementation, or POS app change.
- It does **not** claim that a snapshot, a delta, a sync mechanism, or a
  POS read surface exists today. None of those exist. Catalog Foundation
  ships specification artifacts only; the POS sync feature has not been
  specified yet.
- It does **not** modify the spec, the plan, the data model, the
  research notes, the RLS test matrix, or the tasks document. It is a
  new, standalone direction record cross-referenced from those artifacts.

---

## 8. Cross-references

- Spec clarification: [`Q12`](./spec.md#q12--future-pos-catalog-read-model)
- Spec resolved catalog view: [§6.4](./spec.md#64-resolved-catalog-view-read-model)
- Plan binding constraint table: [§2.1 Q12 row](./plan.md#21-clarifications-treated-as-binding-constraints)
- Plan SaleLine Snapshot obligation: [§3.4](./plan.md#34-future-saleline-snapshot-obligation-binding)
- Plan POS seam task family: [§6.2 F-CAT-POS-SEAM](./plan.md#62-task-families-preview--to-be-expanded-by-speckittasks)
- Research PQ-6 (snapshot signing deferred): [`research.md` PQ-6](./research.md)
- Constitution §4 Contract-First POS Integration; §9 Source-of-Truth Model;
  §10 Retail Temporal Semantics; §11 Idempotency & External IDs; §12
  Authorization & Object Safety.

---

## 9. Status

**Documentation only.** No implementation exists. No endpoint is authored
in this feature. No OpenAPI YAML is authored or referenced. This document
records direction for a future POS sync feature; it does not deliver one.
