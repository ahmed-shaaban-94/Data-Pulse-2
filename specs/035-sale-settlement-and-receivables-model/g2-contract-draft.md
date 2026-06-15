# 035 — G2 Contract DRAFT (design input)

> **DRAFT design input — NOT the authored contract.** This is a markdown design
> sketch of the settlement-and-receivables contract surface, authored after the signed
> owner ruling [`decisions/settlement-receivables-decision-record.md`](./decisions/settlement-receivables-decision-record.md)
> (035-DR-SETTLEMENT). It is **revisable input** for the later `[GATED]` OpenAPI slice
> (tasks.md **T010b**, `packages/contracts/openapi/**`) — it is **not** OpenAPI YAML,
> is **not** under `packages/contracts/`, and does **not** flip gate **G2**. G2 needs
> the authored OpenAPI contract + owner both-sides approval.
>
> **Altitude:** field **families** and operation **shapes** only. **No** physical
> schema — no table names, column types, or migration paths (that is G3). **No** code.
>
> **Carve (035-DR-SETTLEMENT §OQ-4):** this draft covers the **non-reversal happy
> path** only — open / apply / settle / claim / remittance / reconciliation.
> **Reversal-compatibility fields (FR-024) are EXCLUDED** and land in a later additive
> bump after DP-026 closes. Void/refund/insurance-rejection **reuse** DP-026 +
> Connector Arc A + POS-014 (NG-1) — this draft adds no reversal operations.
>
> **Status:** DRAFT — for owner review. **Date:** 2026-06-15.

---

## 0. Conventions assumed by this surface (carried from spec)

- **Tenant/store isolation** on every resource; cross-tenant access → safe 404 (§8, FR-022).
- **Idempotency**: every write accepts an idempotency key; replay-safe (FR-020, §XI).
- **Authorization**: POS writes via the 028-arc operator envelope; Console writes via
  the human session; connector reads/posts via the connector boundary (§8, FR-019).
- **Money**: exact-decimal; amounts as strings at the wire (no floats) — per stack/§III.
- **Audit**: every state transition carries actor/time/before-after/reason (FR-021).
- **Tax**: placeholder carriers only; no VAT allocation (035-DR-SETTLEMENT §OQ-2, NG-4).

---

## 1. Resources (field families — non-physical)

### 1.1 Payer Account
The party responsible for settling a balance (distinct from the buyer at the till).

| Field family | Intent | Notes |
|---|---|---|
| identity reference | who the payer is | provider-neutral; tenant-scoped |
| category | `credit_customer` \| `corporate` \| `insurer` | extensible enum (FR-002) |
| credit terms | placeholder | terms shape deferred to plan/G3 |
| status | active / suspended | governs new receivables |
| tenant / store scope | isolation | (FR-022) |

### 1.2 Receivable
Money owed against a specific sale by a specific payer.

| Field family | Intent | Notes |
|---|---|---|
| sale reference | links to the immutable sale (008/032) | never mutates the sale (FR-006) |
| payer reference | which payer account owes | (FR-005) |
| outstanding balance | money still owed | changes only via audited transitions (FR-007) |
| lifecycle state | see §2 | finite, deterministic |
| tax placeholder | reserved | no allocation (OQ-2) |
| audit trail ref | transitions | (FR-021) |

### 1.3 Payment / Cash Application *(7-C — DP-2-owned operational truth)*

| Field family | Intent | Notes |
|---|---|---|
| applied amount | how much applied | full or partial |
| target receivable(s) | what it reduces | application order defined (FR-011) |
| idempotency key | replay safety | (FR-012) |
| **ERPNext Payment Entry external reference** | pointer to the **accounting projection** ERPNext owns | **7-C**: DP-2 owns this operational record; the ERPNext Payment Entry is a reconciled valuation projection referenced here — **populated only when the connector posting gate (011-DR-POSTING-R1) clears**; nullable until then |

### 1.4 Claim
A receivable (or set) submitted to a third-party payer for collection.

| Field family | Intent |
|---|---|
| claimed receivable(s) | what is being claimed |
| payer reference | the insurer/corporate payer |
| claim status | submitted / acknowledged / reconciled |

### 1.5 Remittance & Reconciliation Result

| Field family | Intent |
|---|---|
| remitted amount(s) | what the payer paid |
| matched claim(s) | what it settles |
| variance | claimed − remitted (recorded, not hidden) |
| reconciliation outcome | feeds settlement state |

---

## 2. Lifecycles (state shapes — non-reversal carve)

### Receivable
```
open ──apply(partial)──► partially_applied ──apply(remainder)──► settled
  │                              │
  └──submit_claim──► claimed ──reconcile──► (settled | partially_applied + variance)
                                   │
                                   └── flagged (variance / negative balance — §4 edge cases)
```
> **Reversal terminal state (`reversal_consumed`) is EXCLUDED from this draft** — it is
> the deferred FR-024 carve (lands after DP-026). When the underlying sale is reversed
> via DP-026, the receivable's reaction is defined in the later additive bump, **not**
> here — and never as a new reversal (NG-1).

### Sale settlement (projection over the immutable sale)
```
unsettled ──► partially_settled ──► settled
```
Independent of the 032 sync-status. Capture is never blocked by settlement (FR-010).

---

## 3. Operations (shapes — non-reversal)

> Names illustrative; final operationIds/paths are the T010b OpenAPI authoring step.
> All writes: idempotency-key header, tenant/store scoped, authorized per §0.

| Op (shape) | Actor | Effect | Outcome |
|---|---|---|---|
| **record settlement intent** | POS | opens receivable(s) from a captured sale's tender split + payer metadata | receivable(s) opened / reject (unknown payer → safe 404) |
| **create / update payer account** | Console | manages payer accounts + terms | created / updated (version-guarded) |
| **apply payment / cash** | Console | reduces receivable balance (7-C, DP-2-owned) | partial_applied / settled / reject (over-application defined, §4) |
| **submit claim** | Console | submits receivable(s) to a payer | claim created |
| **reconcile remittance** | Console / worker | matches remittance to claim, records variance | settled / partial + variance / flagged |
| **read** receivable / payer / claim | POS (scoped) / Console / connector | projections | tenant-scoped reads |

**Excluded by carve (reuse existing surfaces, do not add here):** void, refund,
return, insurance-rejection → DP-026 + Connector Arc A + POS-014 (NG-1).

---

## 4. Role boundaries encoded in the surface

- **POS** — `record settlement intent` + payer metadata only; **never** applies cash,
  authorizes a receivable, or posts money (FR-016).
- **Console** — owns payer-account / receivable / cash-application / claim /
  reconciliation operations (FR-017).
- **Connector** — **later consumer**; reads approved settlement/receivable/claim
  movements and posts the ERPNext Payment Entry **only after** 011-DR-POSTING-R1
  clears. **POS/Console never call ERPNext directly** (7-C; §I trust boundary).
- **DP-2 backend** — authorizes all writes; owns operational truth (7-C).

---

## 5. Explicitly NOT in this draft (held for later gated steps)

| Excluded | Where it lives |
|---|---|
| Reversal-compatibility fields / `reversal_consumed` state | additive bump after DP-026 closes (FR-024, carve) |
| OpenAPI YAML / schemas / examples | T010b `[GATED]` `packages/contracts/openapi/**` |
| Physical schema (tables, columns, types, migrations) | G3 `[GATED]` `packages/db/**` |
| VAT allocation / tax math | G6 / ADR-0003 reopen (OQ-2) |
| Metric names | service/impl slice (§7) |
| Child-repo contracts | their own specs (NG-2) |

---

## 6. Open draft questions for the OpenAPI authoring step (T010b)

> Not blockers — design refinements for when the YAML is authored (plan/contract phase).

- Exact application-order semantics when one payment targets multiple receivables (FIFO
  by age? explicit targeting?). FR-011 says "defined"; the precise rule is a contract-phase pick.
- Over-application outcome: reject vs cap vs record-as-credit (§4 edge case) — pick one
  at authoring; spec requires it be *defined*, not which.
- Whether `submit claim` is DP-2-synchronous or worker-async (likely async per §V) —
  shape only; not decided here.

## 7. Claim ceiling

This draft is **pre-G2 design input**, revisable. It does **not** mark G2 satisfied,
authors no OpenAPI/schema/code, excludes reversal by carve, and keeps tax as
placeholders. Uncommitted; for review.
