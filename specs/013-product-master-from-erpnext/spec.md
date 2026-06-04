# Feature Specification: Product Master from ERPNext

**Feature ID**: 013
**Short name**: product-master-from-erpnext
**Status**: Draft — planning / docs-only (no implementation)
**Created**: 2026-06-04
**Owner**: Ahmed Shaaban
**Constitution version**: 3.0.1

---

## 0. What this spec is (and is not)

This is the **planning spec** for 013 — the third step of the ERPNext
integration arc after **011** (foundation + signed decisions) and **012**
(connector contracts + posting-feed OpenAPI). It is **docs/planning only**:
no application code, no DB schema, no migration, no OpenAPI YAML, no
`package.json`/lockfile, no CI, no connector code. No runtime behavior changes.

Like 011 and 012, this spec has **no `execution-map.yaml` and no dispatchable
code slices**. It establishes purpose, boundaries, the mapping concepts, the
source-of-truth split, and the open questions. **Implementation stays blocked**
until this spec runs its own Spec-Kit chain (`plan.md` → Constitution Check →
`[GATED]` contract/schema, if any → `tasks.md` → `execution-map.yaml`) and the
Agent OS gates clear.

---

## 1. Background & Why

The signed **posting decision** ([011-DR-POSTING](../011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-record.md))
imposes a downstream obligation on 013:

> **013** (product master): item identity/mapping MUST be resolvable so a sale
> line posts against a real ERPNext Item (a posting fails-to-DLQ if not).

The 012 contract (`packages/contracts/openapi/erpnext-connector/posting-feed.yaml`,
PR #481) ships a work-item carrying the 008 sale + `sale_lines`. For the
connector to post a complete ERPNext Sales Invoice (posting decision §1), every
sale line MUST resolve to a **real ERPNext Item**. Today nothing in Data-Pulse-2
links a `tenant_products` row (003 Tenant Catalog) to an ERPNext Item. 013
defines that **mapping** — the identity, barcodes, UOM, price-list references,
active/sellable state, provenance, and the handling of items that cannot (yet)
be mapped — so future sale posting (015) can resolve each DP2 sale line to an
ERPNext Item, and fail cleanly to the DLQ when it cannot.

[integration-boundaries §4](../011-erpnext-pos-reference-and-integration-foundation/integration-boundaries.md)
explicitly defers the **catalog / product master direction** to this spec
(gated by the posting decision). 013 decides that direction here.

---

## 2. Purpose

Define, at the planning level:

- **What ERPNext owns** in the product-master domain (item identity for
  posting) and **what Data-Pulse-2 keeps owning** (the §IX Tenant Catalog as
  the retail/operational source of truth).
- The **mapping link** between a DP2 `tenant_products` row and an ERPNext Item,
  and the concepts that ride on it (barcode, UOM, price-list reference,
  active/sellable state, tenant/store/catalog provenance).
- The **direction of the product-master data flow** (import / mapping over the
  003 catalog, never a POS→Frappe path).
- How an **unresolved or unmapped** ERPNext item case is recorded — and how it
  differs from the already-shipped 003/006/007 **unknown-items** workflow.
- The **boundaries** inherited from 011 that 013 must not violate.
- The **open questions** whose answers must be locked before implementation.

---

## 3. Non-Goals

- No application code, NestJS modules, services, controllers, or workers.
- No `plan.md`, `tasks.md`, `data-model.md`, or contract/OpenAPI YAML in this PR.
- No DB schema, Drizzle schema, or SQL migrations.
- No edit to `docs/outbox/event-types.md`; **no registration of
  `erpnext.posting.requested`** (named in 012 follow-up-notes; registered in its
  own approval PR when 015 needs it).
- No `package.json`, lockfile, CI, generated files, or app source changes.
- No connector-repo code (separate `Retail-Tower-ERP-Next-Connector` repo,
  gated by ADR 0008).
- No POS-Pulse or Retail-Tower-Console changes.
- No **sale posting** (that is 015), no **warehouse / branch-inventory mapping**
  (that is 014), no **tax/fiscal** mapping (that is 016).
- No copying of legacy Data-Pulse code/schema, and **no ERPNext fork or
  core copy-paste** (Constitution §I).
- No collapse of the 003 four-layer catalog model into "a cache of ERPNext".

---

## 4. Actors

| Actor | Role in 013's domain |
|---|---|
| **Tenant Admin** | Owns the Tenant Catalog (003). In 013, the actor whose `tenant_products` get mapped to ERPNext Items; reviews/repairs unmapped cases. |
| **Tenant Owner** | Highest tenant authority; same mapping authority across all stores. |
| **Platform Admin** | Operates the Global Product Index (003 reference layer). **Not** an authority over tenant↔ERPNext mappings. |
| **Retail-Tower-ERP-Next-Connector** *(future, separate repo)* | The **only** component that speaks Frappe. Reads ERPNext Item identity to resolve a posting; holds ERPNext credentials. Reaches DP2 only via the 012 contract. |
| **Data-Pulse-2 (backend)** | Orchestration + contract boundary. Owns the mapping records and the §IX Tenant Catalog; exposes ERP-backed data only as DP2 API shapes. |
| **POS Device / POS Operator** | **Unaware of ERPNext.** Continues to read the resolved DP2 store catalog (003) and trigger the 003 unknown-items workflow on an unresolved scan. Never a participant in the ERPNext mapping. |
| **Anonymous / unauthenticated** | No access. |

---

## 5. Source-of-truth — the mapping/reconciliation split (the crux)

> This section is the constitutional backbone of 013. Everything else flows
> from it. The split mirrors the **signed stock-impact decision**
> ([011-DR-STOCK-IMPACT](../011-erpnext-pos-reference-and-integration-foundation/decisions/stock-impact-decision-record.md)):
> two authorities answering two distinct questions, **reconciled by correlation,
> never merged or one silently overriding the other**.

### 5.1 The split

- **Data-Pulse-2 Tenant Catalog (003 `tenant_products`) remains the
  authoritative retail/operational product record** for a tenant
  (Constitution §IX: "Tenant Catalog is truth for the customer"). It stays
  authoritative for what POS-Pulse and Retail-Tower-Console see and sell:
  the operational product definition, pricing rules, availability, and the
  Store Override layer. **013 does NOT reduce `tenant_products` to a cache of
  ERPNext.**
- **ERPNext owns Item identity for accounting/posting** — the ERPNext **Item**
  doctype a sale line must reference so a submitted Sales Invoice (posting
  decision §1) has a real, GL-affecting item. This is the **accounting** product
  identity, the counterpart to ERPNext owning the GL (posting decision §4) and
  inventory valuation (stock-impact decision).
- **013 is a mapping/reconciliation layer, not a handover of catalog
  authority.** It establishes a link `tenant_products ↔ ERPNext Item` so a sale
  line is **resolvable** to an Item. "Resolvable" (posting decision §013
  obligation) is a *reachability* guarantee, **not** ownership transfer.

### 5.2 What this means concretely

| Fact | Authoritative source (unchanged by 013) |
|---|---|
| Tenant's product definition, pricing rules, categories | **Tenant Catalog (003)** — §IX |
| Branch-level price / availability / tax override | **Store Override (003)** — §IX |
| Historical price/name/tax of a sold line | **SaleLine snapshot (008)** — §IX/§X |
| Accounting Item identity used to post a Sales Invoice | **ERPNext Item** (new in the arc) |
| The link between a tenant product and its ERPNext Item | **DP2 mapping record (013, new)** |

A sale line resolves to an ERPNext Item **through the DP2 mapping**, not by
ERPNext dictating the catalog. The two product views are **reconciled** (a
mapping exists / is current), **never summed or collapsed**.

### 5.3 STOP-and-raise condition

If the owner intends ERPNext to **override** Tenant Catalog authority (i.e.
make ERPNext the source of truth for the retail product definition itself, not
just accounting Item identity), that is a **change to Constitution §IX** and a
deviation from the mapping/reconciliation reading above. Per
[integration-boundaries §5](../011-erpnext-pos-reference-and-integration-foundation/integration-boundaries.md),
that is a **STOP-and-raise-an-ADR** condition — it MUST NOT be baked into 013
silently. It is recorded as **Open Question OQ-1** below.

---

## 6. Boundaries inherited from 011 (non-negotiable)

013 inherits every prohibition from
[integration-boundaries §3](../011-erpnext-pos-reference-and-integration-foundation/integration-boundaries.md):

- **No direct POS-to-Frappe path.** POS-Pulse never calls ERPNext/Frappe;
  it stays on `/api/pos/v1/…` (002) and reads the resolved DP2 store catalog
  (003). ERP-backed data, if any, reaches POS only as ordinary DP2 API
  responses with no Frappe shape leaking through.
- **No ERPNext fork or core copy-paste** (Constitution §I). Bespoke ERPNext
  needs live in the connector's thin custom Frappe app (version-pin decision
  §3), never as forked ERPNext core in this repo.
- **The connector remains the only ERPNext adapter.** It is the only component
  that holds ERPNext credentials and speaks the Frappe API. There is exactly
  **one path** to ERPNext: DP2 → connector → ERPNext.
- **Data-Pulse-2 remains the contract/orchestration boundary.** Every ERP
  interaction is orchestrated here; DP2 owns the OpenAPI contracts POS-Pulse and
  Retail-Tower-Console consume.
- **Retail-Tower-Console** consumes DP2-generated clients only; unaware of
  Frappe. Any ERP-derived screen is unblocked only once the matching `[GATED]`
  DP2 OpenAPI contract is merged (§IV).

---

## 7. Required mapping concepts

These are the concepts 013 must model when it reaches implementation. **Named
and bounded here; not schema'd.** Each is defined as an extension over the 003
catalog, not a replacement.

### 7.1 ERPNext Item
The ERPNext **Item** doctype (accounting product identity). 013 stores a
**reference** to it (e.g. the ERPNext Item code/name) on the DP2 side, linked to
a `tenant_products` row. DP2 speaks in DP2 terms; the connector maps the
DP2-facing reference to the live ERPNext doctype (version-independence, 012 O-6).
**ERPNext Item identity is the accounting counterpart to the §IX Tenant Catalog
product, not its replacement** (§5).

### 7.2 Barcode
ERPNext models item barcodes; 003 models barcodes/SKUs/PLUs/external POS
identifiers as **`product_aliases`**. 013 must define how a 003 alias relates to
an ERPNext Item Barcode for posting resolution — **without** moving alias
authority out of the 003 catalog (003 alias uniqueness/conflict rules stand).

### 7.3 UOM (unit of measure)
ERPNext posts in a stock/selling UOM. 013 must define how a DP2 sale line's
unit maps to the ERPNext Item's UOM so quantities post correctly (posting
decision §1 amounts/quantities). UOM-conversion ownership and the
no-silent-rounding posture (§III money/quantity exactness) are open questions
(OQ-3).

### 7.4 Price List reference
ERPNext Sales Invoices reference a **Price List**. 013 models a **reference**
to the relevant ERPNext Price List for a tenant/store, **without** moving
pricing authority out of DP2: per §IX and the posting decision, **POS totals are
preserved as received** and **DP2 amounts are authoritative for the posted
invoice** (posting decision §4 — posted amounts reconcile to DP2 sale totals).
The Price List reference exists for ERPNext document validity, **not** to let
ERPNext reprice a DP2 sale. Whether the posting sends explicit per-line amounts
vs relies on a Price List is an open question (OQ-4).

### 7.5 Active / sellable state
Both DP2 (003 retire/availability) and ERPNext (Item `disabled` / `is_sales_item`)
carry an enabled/sellable notion. 013 must define which state governs
**resolvability for posting** (an ERPNext Item that is disabled cannot receive a
posting) while keeping **operational sellability authoritative in DP2** (what POS
sells is the 003 resolved catalog, §IX). State **divergence** (DP2 sellable but
ERPNext Item disabled, or vice versa) is a reconciliation case, not a silent
override (OQ-5).

### 7.6 Tenant / store / catalog provenance
Every mapping record carries provenance consistent with §XIII and the 012 O-1
work-item: the **tenant** scope (RLS-isolated, §II), the **store** scope where a
mapping is store-specific, the **source 003 catalog layer** it maps from
(tenant vs store-override), and **when/by whom** the mapping was established or
last reconciled. Provenance lets a posting failure (unmapped item) be traced to
the exact DP2 product and tenant (posting decision §5 failure posture).

### 7.7 Unresolved / unmapped ERPNext item cases
A `tenant_products` row (or a sale line referencing it) for which **no current
ERPNext Item mapping exists**. This is the case the posting decision's
"fails-to-DLQ if not" clause targets.

> **This is NOT the 003/006/007 `unknown-items` workflow** — the two MUST be kept
> distinct (see §8). 013's unmapped-item case is the **outbound/posting**
> direction (a known DP2 product lacks an ERPNext Item link); the existing
> unknown-items queue is the **inbound/POS** direction (a scanned identifier that
> doesn't resolve to any DP2 product at all). 013 must define how an unmapped
> case is detected, surfaced, and repaired — and explicitly state its
> relationship to (not merger with) the unknown-items queue.

---

## 8. Relationship to the shipped `unknown-items` workflow

The 003 catalog foundation defined, and 005/006/007 shipped, an **Unknown Items
Review Queue**: when a POS scan or import presents an identifier that does not
resolve to any tenant product, it is recorded for review **without silently
creating a trusted product**. That is an **inbound, POS-direction** mechanism.

013's **unmapped ERPNext item** is a **different concept**:

| Dimension | 003/006/007 `unknown-items` | 013 unmapped ERPNext item |
|---|---|---|
| Direction | Inbound (POS scan / import → DP2) | Outbound (DP2 product → ERPNext posting) |
| Trigger | Scanned identifier resolves to no `tenant_products` | A `tenant_products` row has no current ERPNext Item mapping |
| Actor | POS Operator / import flow | Posting resolution (015) / mapping review (Tenant Admin) |
| Remedy | Review queue → link/create/dismiss a tenant product | Establish/repair the tenant_product ↔ ERPNext Item mapping; posting fails-to-DLQ until then (posting decision §5) |

013 MUST NOT reuse or overload the unknown-items queue for the unmapped-mapping
case, and MUST NOT invent a parallel "unresolved" mechanism that silently
collides with it. The relationship between the two (e.g. resolving an unknown
item may later require a 013 mapping before that product can post) is itself an
open question (OQ-6).

---

## 9. Dependencies & gates

- **depends_on**: **012-erpnext-connector-contracts** — **MERGED** (planning
  PR #476; ADR 0008 accepted #479; `[GATED]` 012-CONTRACT posting-feed OpenAPI
  #481; closeout #482). The work-item shape 013 resolves items *for* is on `main`.
- **gated_by**: the signed **posting decision**
  (011-DR-POSTING, **SIGNED** 2026-06-03 — gates 012/013/015/017). 011's
  signed-decision gate is **SATISFIED**.
- **Not gated by** stock-impact or tax/fiscal directly, but 013 is **sequenced
  before** 014 (warehouse mapping) and 015 (sale posting): you cannot post a
  sale line (015) referencing an item with no agreed master/mapping
  ([follow-up-spec-map §013](../011-erpnext-pos-reference-and-integration-foundation/follow-up-spec-map.md)).
- **Implementation remains blocked** until 013 has its own `plan.md` /
  `tasks.md` / `execution-map.yaml` and the Agent OS gates clear. Any DB
  schema, migration, or OpenAPI contract that 013 eventually needs is a separate
  `[GATED]` slice (§VIII / standing rules §3).

---

## 10. Explicit assumptions

### A-1 — ERPNext major version is UNCONFIRMED by staging validation
Per the signed **version-pin decision**
([011-DR-VERSION-PIN](../011-erpnext-pos-reference-and-integration-foundation/decisions/version-pin-upgrade-policy.md) §1):
the reference-lab baseline **may** be ERPNext/Frappe **v15**, but the **final
supported major and exact point releases are confirmed in 012 after
staging-install validation** (still pending). By mid-2026 v16 exists alongside
v15, so the major is deliberately not hard-locked.

> **013 MUST NOT assume v15 as implementation truth.** Any concept in §7 that is
> version-sensitive (the ERPNext Item doctype shape, Barcode child-table,
> UOM-conversion model, Price List structure) MUST be treated as
> **version-independent at the DP2 contract boundary** (012 O-6): the connector
> absorbs ERPNext version differences; the DP2-facing mapping speaks in DP2 terms.
> The concrete ERPNext doctype field mapping is the connector's internal concern
> and is pinned only when the version-pin staging validation completes.

### A-2 — DP2 ↔ connector contract is version-independent
013's mapping concepts are expressed in DP2/Retail-Tower terms, not ERPNext
doctype field names (012 O-6). An ERPNext upgrade changes the connector's
internal mapping, never 013's DP2-facing model.

### A-3 — No new external dependency is implied
013 does **not** authorize an ERPNext/Frappe client dependency in any DP2
package. Such a dependency is a separate `[GATED]` `package.json` decision
(version-pin decision §6; standing rules §3) — and in any case lives in the
connector repo, not DP2.

---

## 11. Open questions (must be locked before implementation)

| ID | Question | Why it blocks |
|---|---|---|
| **OQ-1** | Does ERPNext Item identity ever **override** the §IX Tenant Catalog, or is 013 strictly a mapping/reconciliation layer (the §5 reading)? | If override is intended, it is a §IX amendment / ADR (STOP-and-raise, §5.3) — it cannot be assumed. The §5 reading (mapping only) is the working assumption pending owner confirmation. |
| **OQ-2** | Mapping cardinality: is it 1:1 `tenant_products ↔ ERPNext Item`, or may many DP2 products map to one Item (or one product to many Items per store/UOM)? | Determines the mapping record grain, uniqueness constraints, and how a sale line resolves. |
| **OQ-3** | UOM-conversion ownership: does DP2 store the conversion, or does the connector convert against the ERPNext Item UOM? What is the no-silent-rounding posture? | §III exactness; wrong UOM posts wrong quantities. |
| **OQ-4** | Does a posting send explicit per-line amounts (DP2-authoritative, posting decision §4) or rely on an ERPNext Price List? | Pricing authority (§IX) vs ERPNext document validity; must not let ERPNext reprice a DP2 sale. |
| **OQ-5** | Sellable-state divergence (DP2 sellable vs ERPNext Item disabled): how is it detected and reconciled, and which governs posting resolvability? | A disabled ERPNext Item cannot receive a posting; operational sellability stays DP2-authoritative (§IX). |
| **OQ-6** | Relationship between resolving a 003 unknown-item and establishing a 013 ERPNext mapping (does linking an unknown item then require a 013 mapping before it can post?). | Avoids the two mechanisms silently colliding (§8). |
| **OQ-7** | Mapping lifecycle: how is a mapping established (manual Tenant-Admin action, bulk import from ERPNext, suggested-then-confirmed), and how is it kept current when the ERPNext Item changes? | Drives whether 013 needs an import worker, an outbox event, and a reconciliation surface (ties to 014/017). |
| **OQ-8** | Direction of the initial **product-master import**: does 013 import the ERPNext Item catalog into DP2 mappings, or only link existing `tenant_products` on demand at posting time? | Determines whether 013 is a pull/import feature or a lazy-resolution feature; affects 012-style feed needs. |

---

## 12. Constitution Check (planning-level)

This spec is docs-only, so the check is at the **design-intent** level; a full
per-task Constitution Check lands in 013's future `plan.md`.

| Principle | How 013 (as specified) complies |
|---|---|
| **§I Reference, not source of truth** | No ERPNext fork / core copy-paste (§3, §6). Bespoke ERPNext lives in the connector's custom Frappe app, not this repo. |
| **§II Multi-tenant RLS** | Every mapping record is tenant-scoped (§7.6); cross-tenant non-disclosure (404) holds on any future mapping read/write. Concrete RLS is a future gated slice. |
| **§III Backend authority & integrity** | Money/quantity exactness preserved (§7.3/§7.4); DP2 amounts authoritative for the posted invoice; POS totals preserved as received. |
| **§IV Contract-first** | The connector is the only ERPNext edge; any ERP-backed DP2 endpoint ships as a `[GATED]` OpenAPI contract first (§6). DP2 owns the contracts. |
| **§IX Source-of-truth model** | **The discriminating check.** 013 is a mapping/reconciliation layer; Tenant Catalog stays authoritative for the retail view; ERPNext owns accounting Item identity only (§5). Any override intent is a STOP-and-raise ADR (§5.3, OQ-1). |
| **§XI Idempotency & external IDs** | Posting resolution reuses the sale's `sourceSystem + externalId` provenance (012 O-1/O-3); mapping establishment must be idempotent (future slice). |
| **§XIII Auditability & provenance** | Mapping records carry tenant/store/source-layer/when/by-whom provenance (§7.6); unmapped cases are traceable for repair (§7.7). |
| **§VIII Reproducible releases** | No `package.json`/lockfile/schema/migration change in this PR; ERPNext version pin is an explicit unconfirmed assumption (§10 A-1), not a silent lock. |

No principle is violated by this planning spec. The one principle that
**constrains the design** (and could be violated by a careless implementation)
is **§IX** — addressed head-on in §5 and gated by OQ-1.

---

## 13. Follow-up slices (proposals only — NOT executable yet)

These are **proposed**, not green-lit. Each requires 013's own Spec-Kit chain
and Agent OS gates before any code:

- **013-PLAN** — author `plan.md` + Constitution Check + Architecture Impact Map.
- **013-MAPPING-MODEL** — `data-model.md` for the mapping record(s), once OQ-1/2/7/8
  are locked. Any schema is a separate `[GATED]` slice.
- **013-CONTRACT** *(if needed)* — any ERP-backed DP2 OpenAPI surface for mapping
  review/repair (`[GATED]`, §IV) — only if an admin/console surface is required.
- **013-RESOLVE** — the posting-time resolution path (sale line → ERPNext Item via
  mapping; unmapped → fails-to-DLQ per posting decision §5). Sequenced with 015.

Numbering and scope are advisory until each runs its planning chain.

---

## 14. Acceptance criteria (for this planning spec)

- [ ] Purpose, boundaries, and the §IX mapping/reconciliation split are stated
      and do not contradict 003 catalog ownership or 011 boundaries.
- [ ] The seven required mapping concepts (§7) are each named and bounded.
- [ ] The unmapped-item case is explicitly distinguished from the shipped
      unknown-items workflow (§8).
- [ ] The ERPNext-version-unconfirmed assumption is explicit (§10 A-1); v15 is
      not assumed as implementation truth.
- [ ] Dependencies/gates are accurate (012 merged, posting decision SIGNED) and
      implementation is stated as blocked pending 013's own plan/tasks/map (§9).
- [ ] Follow-up slices are proposals only (§13).
- [ ] No runtime/OpenAPI/DB/package/lockfile/CI/connector/POS/Console file is
      touched; changed files are only under `specs/013-product-master-from-erpnext/`.
