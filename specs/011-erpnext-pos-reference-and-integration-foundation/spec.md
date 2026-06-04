# Feature Specification: ERPNext POS Reference & Integration Foundation

**Feature ID**: 011
**Short name**: erpnext-pos-reference-and-integration-foundation
**Feature Branch**: `feat/011-erpnext-pos-reference-and-integration-foundation`
**Created**: 2026-06-03
**Status**: Draft — **docs/spec only** (no code, no schema, no contract YAML)
**Owner**: Ahmed Shaaban
**Depends on**: [docs/architecture/repo-boundaries.md](../../docs/architecture/repo-boundaries.md), [docs/architecture/future-repo-split-criteria.md](../../docs/architecture/future-repo-split-criteria.md), [docs/architecture/feature-placement-rules.md](../../docs/architecture/feature-placement-rules.md), [docs/ROADMAP-ERP.md](../../docs/ROADMAP-ERP.md)
**Consumed by**: A future custom Frappe app/repo, **Retail-Tower-ERP-Next-Connector** (separate repository — does not exist yet; see §7)
**Constitution version**: 3.0.1 — primary touchpoints §IV (Contract-First Integration / trust boundary), §IX (Source-of-Truth Model), §III (Backend Authority), §XII (Object Safety), §XIV (PII / data-class discipline)

**Input**: User description — create a docs-only Spec Kit foundation feature that establishes ERPNext/Frappe as the reference ERP/accounting/inventory system for Retail Tower OS, fixes the integration boundaries (POS-Pulse never calls Frappe directly; Retail-Tower-Console consumes Data-Pulse generated clients only; ERPNext POS is reference-only, never the production cashier terminal), and records the decisions that MUST be signed before any ERPNext integration code is written.

---

## Clarifications

### Session 2026-06-03

- Q: Is 011 a code feature or a docs/spec feature? → A: **Docs/spec only.** No application code, no DB schema or migrations, no OpenAPI YAML, no package/lockfile changes, no connector client code. This slice produces a specification and a set of **decision-record placeholders** that gate the downstream specs. (Scope locked.)
- Q: Is ERPNext the production POS / cashier terminal? → A: **No.** ERPNext/Frappe is the **ERP/accounting/inventory reference system**. **ERPNext POS behavior is reference-only** — it informs how Retail Tower OS thinks about posting, stock, and tax, but the production cashier terminal remains **POS-Pulse**. (Role locked.)
- Q: May POS-Pulse call Frappe/ERPNext directly? → A: **Never.** All POS↔ERP communication flows through Data-Pulse-2's versioned OpenAPI contracts and (eventually) the connector. Data-Pulse-2 remains the backend contract and orchestration boundary; ERPNext is reachable only via that boundary. (Trust boundary locked, consistent with Constitution §IV and [repo-boundaries.md](../../docs/architecture/repo-boundaries.md).)
- Q: Does Retail-Tower-Console talk to ERPNext? → A: **No.** Retail-Tower-Console remains **frontend-only** and consumes **Data-Pulse-generated clients only**. It has no awareness of Frappe. (Console boundary locked.)
- Q: Where does the connector live? → A: A **separate future custom Frappe app/repo**, **Retail-Tower-ERP-Next-Connector**. It is framed as a **concrete instance of the already-named `Retail-Tower-Integrations` candidate** in [future-repo-split-criteria.md](../../docs/architecture/future-repo-split-criteria.md), and its creation is gated behind that document's **ADR-required split process** — no connector repo is created by this spec. (Connector home locked — Decision context, see §7.)
- Q: The 011–017 numbers conflict with `docs/ROADMAP-ERP.md` (which proposed 011=Purchasing, 012=Reporting). Which numbering wins? → A: **011–017 are claimed for the ERPNext integration arc.** `ROADMAP-ERP.md` is **stale** — its header explicitly states the numbers `008`–`012` are "proposed identifiers, not reserved," and the repo actually shipped 008=Sales, 009=Inventory, 010=POS catalogue read-down. This spec records the supersession; a one-line erratum pointer is added to `ROADMAP-ERP.md` (the brief permits roadmap updates where conventions require). (Numbering locked — Decision context, see §6.)
- Q: Does 011 implement catalog import, inventory sync, sale posting, or tax logic? → A: **No.** Those are the downstream specs 012–017 (§8). 011 only fixes the foundation and the **signed-decision gate** that precedes them. (Implementation deferral locked.)

---

## 1. Background & Why

Retail Tower OS owns a **retail operations loop** — *sell → record money → move stock → restock → see the numbers* — across three repositories: **Data-Pulse-2** (backend, source of truth), **POS-Pulse** (cashier terminal), and **Retail-Tower-Console** (admin UI). The shipped backend already owns the first half of that loop: catalog (003), POS catalog sync/reconciliation (005/007), the immutable sale fact (008), and the append-only inventory stock ledger (009), with the POS catalogue read-down (010) currently active.

To become a **meaningful retail ERP** — proper double-entry accounting, fiscal/tax compliance (Egypt v1), authoritative inventory valuation, and purchasing — the product needs an ERP backbone it is not going to build from scratch. The chosen reference ERP is **ERPNext / Frappe**: a mature, open-source ERP that already models the chart of accounts, stock ledger valuation, tax templates, and POS flows.

This creates a risk the product has *not* yet bounded: **how ERPNext relates to the three existing repositories without dissolving the trust boundary.** Specifically:

- ERPNext ships its **own POS** (the "POS Awesome" / Frappe POS surface). If that is mistaken for *the* cashier terminal, POS-Pulse's role evaporates and the offline-first cashier UX is lost.
- ERPNext exposes a **REST API**. If POS-Pulse or Retail-Tower-Console call it directly, the Constitution §IV trust boundary ("all POS↔backend communication flows through documented, versioned, authenticated API contracts — no direct DB access, shared filesystems, or undocumented endpoints") is breached, and Data-Pulse-2 stops being the source of truth.
- ERPNext posting (Sales Invoice / Stock Entry / Payment Entry), stock valuation, and tax behavior carry **irreversible accounting consequences**. Wiring them up before the *posting model, stock-impact model, tax/fiscal model, and version-pin policy* are decided would bake in choices that are expensive to reverse once real ledgers exist.

**011 fixes the foundation before any of that is built.** It does three things, and only these three:

1. Establishes **ERPNext as the reference ERP** and **ERPNext POS as reference-only** (not the production cashier).
2. Pins the **integration boundaries** so every downstream spec inherits a consistent trust model.
3. Stands up the **signed-decision gate** — four decision records (posting, stock impact, tax/fiscal, version pin) that MUST be signed before any ERPNext integration code (012–017) ships.

It is the architectural "constitution amendment" for the ERPNext arc, expressed as docs.

---

## 2. Goals

- Establish, in repo docs, that **ERPNext/Frappe is the ERP/accounting/inventory reference system** for Retail Tower OS, and that **ERPNext POS is reference-only** — never the production cashier terminal (that stays POS-Pulse).
- Fix the **integration boundaries** so they cannot drift:
  - Data-Pulse-2 remains the **backend contract and orchestration boundary**.
  - **POS-Pulse never calls Frappe/ERPNext directly.**
  - **Retail-Tower-Console remains frontend-only** and consumes **Data-Pulse-generated clients only**.
  - The connector lives in a **separate future Frappe repo** (`Retail-Tower-ERP-Next-Connector`), gated by the existing ADR split process.
- Produce an **ERPNext POS reference map** that translates ERPNext POS concepts into Retail Tower OS terms (and marks what is reference-only vs what DP2 already owns).
- Stand up four **decision records** — posting, stock impact, tax/fiscal (Egypt v1), version pin & upgrade policy — authored as explicit **`Status: UNSIGNED — BLOCKS IMPLEMENTATION`** placeholders and signed by the owner before any downstream implementation (now **SIGNED** 2026-06-03; see §9).
- Publish a **follow-up spec map** for **012–017** with dependencies and gates, so the integration arc is sequenced before any of it is green-lit.
- Define **acceptance criteria** that require the four decision records to be **signed** before any 012–017 implementation begins.

---

## 3. Non-Goals

This feature is **docs/spec only**. It explicitly does **not**:

- Modify any **application code** (no NestJS modules, services, controllers, workers, jobs).
- Modify any **DB schema or migrations** (no Drizzle schema, no SQL under `packages/db/drizzle/`).
- Modify any **OpenAPI YAML** (`packages/contracts/openapi/**`).
- Modify **`package.json`, `pnpm-lock.yaml`, or any lockfile**.
- Add any **connector client code**, ERPNext SDK, Frappe API client, or HTTP wiring.
- Touch **POS, Console, billing, reporting, analytics, ClickHouse, Dagster, dbt, or CI** (`.github/**`).
- **Implement** catalog import, inventory sync, sale posting, or tax logic — those are 013/014/015/016 (§8).
- Create the **`Retail-Tower-ERP-Next-Connector` repository** — that requires an accepted ADR per [future-repo-split-criteria.md](../../docs/architecture/future-repo-split-criteria.md).
- **Sign** any of the four decision records — 011 stands up the *placeholders*; signing is a separate owner act (the acceptance gate, §9).
- Author `plan.md`, `tasks.md`, `execution-map.yaml`, `data-model.md`, `research.md`, or contract YAML — a foundation spec PR is docs-only, consistent with the 010 spec's own §3 Non-Goals. These artefacts (if needed) belong to the downstream 012–017 specs.
- Add or change **runtime behavior** of any kind. No code path changes; nothing reads or writes differently after this PR.

---

## 4. Actors

| Actor | Role in this foundation |
|---|---|
| **Data-Pulse-2 (backend)** | The **source of truth** and the **only** system permitted to talk to ERPNext (via the future connector). Owns the OpenAPI contracts every other repo consumes. Remains the orchestration boundary for all ERP interactions. |
| **ERPNext / Frappe** | The **reference ERP/accounting/inventory system**. Reachable only through Data-Pulse-2 + the connector. Its **POS surface is reference-only** — studied, never adopted as the cashier terminal. |
| **Retail-Tower-ERP-Next-Connector** *(future repo, does not exist yet)* | A separate custom Frappe app/repo that will mediate Data-Pulse-2 ↔ ERPNext. A concrete instance of the `Retail-Tower-Integrations` split candidate. Created only after an accepted ADR. |
| **POS-Pulse (cashier terminal)** | The production cashier. **Never calls Frappe/ERPNext directly.** Continues to integrate exclusively via Data-Pulse-2's POS contracts (`/api/pos/v1/...`). Unaware of ERPNext. |
| **Retail-Tower-Console (admin UI)** | **Frontend-only.** Consumes **Data-Pulse-generated clients only**. Unaware of Frappe. ERP-backed data reaches it as ordinary Data-Pulse API responses. |
| **Owner / Architect** | The signer of the four decision records (§9). No 012–017 implementation begins until they sign. |

---

## 5. Integration boundaries (summary)

The full statement lives in [integration-boundaries.md](./integration-boundaries.md). In one diagram:

```
   POS-Pulse ─────┐
                  │ (POS OpenAPI contracts only)
                  ▼
            Data-Pulse-2  ◀────────── Retail-Tower-Console
          (source of truth,            (frontend-only;
           orchestration                generated DP2 clients only)
           boundary)
                  │
                  │ (the ONLY arrow that touches ERPNext;
                  │  mediated by the future connector)
                  ▼
   Retail-Tower-ERP-Next-Connector  ──▶  ERPNext / Frappe
        (future separate repo)            (reference ERP;
                                            POS surface = reference-only)
```

**Invariant**: there is exactly **one** path to ERPNext — through Data-Pulse-2 and the connector. POS-Pulse and Retail-Tower-Console have **no** edge to ERPNext. This is the Constitution §IV trust boundary applied to the ERP backbone.

---

## 6. Numbering: relationship to `ROADMAP-ERP.md`

**Decision (recorded here):** the identifiers **011–017 are claimed for the ERPNext integration arc** (this spec + the follow-up map in §8).

`docs/ROADMAP-ERP.md` proposed a different sequence (011=Purchasing, 012=Reporting). That roadmap is **superseded** for these numbers because:

- Its own header states the identifiers `008`–`012` are *"proposed identifiers, not reserved."*
- The repo actually shipped **008=Sales-Transaction-Capture**, **009=Inventory-Stock-Ledger**, **010=POS-Catalogue-Read-Down** — already diverging from the roadmap's 008→012 chain.
- The retail-loop capabilities the roadmap named (Payments, Purchasing, Reporting) are **not cancelled** — they are re-homed onto the ERPNext backbone (e.g. purchasing/reporting become ERPNext-backed rather than greenfield DP2 tables) or remain future DP2 specs that will take their own free numbers after 017.

A one-line erratum pointer is added to `ROADMAP-ERP.md` directing readers here. No other change is made to that file (it remains a useful record of the pre-ERPNext retail-loop reasoning).

---

## 7. Connector repo: relationship to `Retail-Tower-Integrations`

**Decision (recorded here):** the future **`Retail-Tower-ERP-Next-Connector`** is the **concrete instance** of the already-named **`Retail-Tower-Integrations`** split candidate in [future-repo-split-criteria.md](../../docs/architecture/future-repo-split-criteria.md) ("Create only when … ERP/accounting connectors … become substantial. Triggering boundary: security (external credentials, blast radius) and team ownership (connector roadmap)").

Consequences:

- The connector is **not created by this spec.** Its creation follows the existing **process for a split**: confirm a boundary test is met → open an ADR under `.specify/memory/decisions/` proposing the split, its contract surface, and its data ownership → get the decision accepted → only then create the repo, preserving the OpenAPI contract boundary with Data-Pulse-2.
- This avoids inventing a second, overlapping "connector repo" concept. There is one candidate (`Retail-Tower-Integrations`); `Retail-Tower-ERP-Next-Connector` is its ERPNext realization (the repo name MAY be finalized in the split ADR).
- Until that ADR is accepted, ERPNext integration logic, if any prototyping is approved, would start as a **backend module** in Data-Pulse-2 (per feature-placement-rules.md), never as direct calls from POS-Pulse or Console.

---

## 8. Follow-up spec map (012–017)

These are **proposed, not green-lit.** Each must run its own Spec-Kit planning chain and Agent OS gates, and each is **blocked** until the four 011 decision records are **signed** (§9). The full map with rationale lives in [follow-up-spec-map.md](./follow-up-spec-map.md); summary:

| Spec | Domain | Depends on | Gated by (011 decision) |
|---|---|---|---|
| **012-erpnext-connector-contracts** | The OpenAPI contract surface + connector lifecycle between DP2 and ERPNext | 011 (signed) | Posting + Version-pin |
| **013-product-master-from-erpnext** | Product/item master sourced from ERPNext (catalog import direction) | 012 | Posting |
| **014-branch-inventory-reconciliation-and-warehouse-mapping** | ERPNext Warehouse ↔ DP2 store/branch mapping + reconciliation/mismatch detection (NOT an ERPNext stock read-down; DP2 stays the operational availability authority) | 012, 013 | Stock-impact |
| **015-pos-sale-posting-to-erpnext** | Posting DP2 sale facts (008) into ERPNext (Sales Invoice / Payment / Stock Entry) | 012, 013, 014 | Posting + Stock-impact |
| **016-tax-and-fiscal-egypt-v1** | Egypt tax/fiscal compliance (e-invoice / ETA) over the posting path | 015 | Tax/fiscal |
| **017-sync-ops-and-repair-api** | Sync operations, reconciliation, retry/DLQ, and repair API for the connector | 012–016 | Posting + Stock-impact + Version-pin |

> **Note**: numbers 012–017 are reserved by this spec for the ERPNext arc; like all Spec-Kit identifiers they are proposed until each spec is created. Capabilities from the old `ROADMAP-ERP.md` (Payments/Tender, standalone Purchasing, Reporting) are either re-homed onto the ERPNext backbone above or take free numbers after 017 in their own future specs.

---

## 9. Acceptance Criteria

This feature is **complete** (mergeable as a docs-only foundation) when **all** of the following hold:

1. **AC-1 — Spec exists.** `specs/011-erpnext-pos-reference-and-integration-foundation/spec.md` (this file) is present with Background, Goals, **Non-Goals (§3)**, Actors, Integration boundaries, Numbering decision, Connector decision, Follow-up map, and these acceptance criteria.
2. **AC-2 — Reference map exists.** `erpnext-pos-reference-map.md` translates ERPNext POS concepts to Retail Tower OS terms and explicitly marks ERPNext POS as **reference-only**.
3. **AC-3 — Boundaries doc exists.** `integration-boundaries.md` states the trust boundaries (POS-Pulse never calls Frappe; Console consumes DP2 clients only; one path to ERPNext via DP2 + connector).
4. **AC-4 — Four decision records exist.** `decisions/posting-decision-record.md`, `decisions/stock-impact-decision-record.md`, `decisions/tax-fiscal-egypt-decision-record.md`, and `decisions/version-pin-upgrade-policy.md` each exist. They were authored as `UNSIGNED — BLOCKS IMPLEMENTATION` placeholders and are now **SIGNED** (owner Ahmed Shaaban, 2026-06-03) — see the gate status below.
5. **AC-5 — Follow-up map exists.** `follow-up-spec-map.md` lists 012–017 with dependencies and the gating decision per spec.
6. **AC-6 — Docs-only.** The PR changes **no** application code, DB schema/migration, OpenAPI YAML, `package.json`/lockfile, or CI; it adds no connector code and changes no runtime behavior. (The only file touched outside `specs/011-…/` is a one-line erratum pointer in `docs/ROADMAP-ERP.md`.)

### The signed-decisions gate (blocks 012–017)

> **No 012–017 implementation may begin until all four decision records in `decisions/` are signed.**

Each decision record is signed when it carries an explicit owner sign-off (date + signer) and `Status: SIGNED`. A record left `UNSIGNED` is a **hard stop** on the spec(s) it gates per the table in §8. This makes the gate enforceable rather than decorative: an agent dispatched to start 012 MUST verify the gating decision(s) are `SIGNED` first, and STOP-and-report otherwise.

| Decision record | Status | Must be signed before |
|---|---|---|
| `posting-decision-record.md` | ✅ SIGNED 2026-06-03 | 012, 013, 015, 017 |
| `stock-impact-decision-record.md` | ✅ SIGNED 2026-06-03 | 014, 015, 017 |
| `tax-fiscal-egypt-decision-record.md` | ✅ SIGNED 2026-06-03 | 016 |
| `version-pin-upgrade-policy.md` | ✅ SIGNED 2026-06-03 | 012, 017 |

**Gate status: SATISFIED.** All four records are SIGNED (owner Ahmed Shaaban, 2026-06-03). The downstream specs 012–017 are **unblocked** to begin their own Spec-Kit planning chains and Agent OS gates, each consistent with its gating decision(s).

---

## 10. Closeout note

This is a **docs-only** foundation. After this PR:

- **No code changed.** No NestJS module, service, controller, worker, or job was added or modified.
- **No schema or migration changed.** `packages/db/**` is untouched; no Drizzle schema, no SQL.
- **No OpenAPI changed.** `packages/contracts/openapi/**` is untouched.
- **No `package.json` / lockfile / CI changed.**
- **No runtime behavior changed.** Nothing reads or writes differently; there is no new code path.
- **No connector exists.** `Retail-Tower-ERP-Next-Connector` is named as a future repo, gated by an ADR; it is not created here.

The deliverable is a specification + four decision records + a follow-up map. The four decision records — authored as `UNSIGNED` placeholders in the foundation PR (#468, merged) — are now **SIGNED** (owner Ahmed Shaaban, 2026-06-03). The signed-decisions gate is therefore **SATISFIED**, and the next step is to begin planning **012-erpnext-connector-contracts** (consistent with the posting + version-pin decisions). See [wave-status.md](./wave-status.md) for the human-readable state.
