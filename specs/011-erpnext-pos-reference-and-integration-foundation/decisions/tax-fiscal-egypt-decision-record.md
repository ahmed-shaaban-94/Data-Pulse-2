# Decision Record: Tax & Fiscal Model — Egypt v1

**Decision ID**: 011-DR-TAX-FISCAL-EG
**Feature**: 011-erpnext-pos-reference-and-integration-foundation
**Status**: **SIGNED**
**Gates**: spec **016** (per spec §9)
**Owner / signer**: Ahmed Shaaban
**Created**: 2026-06-03
**Signed**: 2026-06-03

> **SIGNED.** A decision has been recorded below. The spec this record gates
> (016) may proceed through its own Spec-Kit planning chain and Agent OS gates,
> consistent with this decision. Any deviation from it is a STOP-and-raise
> condition, not a silent override.

---

## Question to be decided

**How is tax computed and how are fiscal/compliance obligations (Egypt v1) satisfied across the DP2 → ERPNext posting path?**

Sub-questions the signed decision MUST answer:

1. **Tax authority** — is tax **computed** by DP2, by ERPNext (tax templates), or by POS-Pulse at sale time and preserved as received (§III "POS totals preserved as received")? Where is the authoritative tax amount per sale line?
2. **Tax category mapping** — how does the DP2 catalog `tax_category` map to an ERPNext Item Tax / Tax Template? Inclusive vs exclusive tax handling.
3. **Egypt e-invoice / ETA** — what is the obligation surface (Egyptian Tax Authority e-invoice / e-receipt)? Does ERPNext (or a Frappe app) handle ETA submission, and what does DP2 / the connector pass through?
4. **Rounding policy** — invoice-vs-line rounding (the Constitution §III / ROADMAP-ERP §3 open gate). Must be pinned before any tax-bearing posting ships.
5. **Multi-tax composition** — how are multiple taxes (e.g. VAT + table service / other levies) composed and ordered?
6. **Fiscal document numbering** — naming series / fiscal sequence ownership (ERPNext vs DP2 vs ETA-assigned).
7. **Historical immutability** — posted tax/fiscal documents are immutable historical truth (§IX SaleLine snapshot); corrections are new documents (credit notes), never edits.

## Constraints any decision MUST respect

- Money is exact-decimal (§III, no floats); tax math must be lossless to the currency minor unit.
- §III: SaaS MAY reconcile and flag mismatches but MUST NOT silently rewrite historical POS totals.
- Fiscal/compliance documents, once submitted, are immutable; reversal is via new documents.
- PII / customer-identifying fiscal data follows §XIV data-class discipline.

## Decision

Tax is **computed at the POS and preserved as received**; the **Retail Tower
ERPNext Connector custom Frappe app owns the ERP-side ETA submission adapter
(gated by 016)** — **Data-Pulse does not submit to ETA directly in v1**; rounding
is **line-level to the EGP minor unit**. Each numbered item answers the
correspondingly-numbered sub-question above.

1. **Tax authority — POS-computed, preserved as received; ERPNext reconciles.**
   The tax amount captured at the POS (carried in the 008 sale fact, per line)
   is **authoritative** and is posted to ERPNext **as received**. ERPNext
   re-computes via its tax templates and **flags mismatches** (reconciliation),
   but **MUST NOT silently overwrite** the POS-received total (§III). The
   customer's receipt tax and the filed invoice tax are the same number. (ERPNext
   computing tax authoritatively, or DP2 building its own tax engine, are both
   **rejected** for v1 — the former risks rewriting POS totals, the latter
   duplicates the ERP backbone.)

2. **Tax category mapping.** The DP2 catalog `tax_category` maps to an ERPNext
   **Item Tax Template / Tax Category** (the concrete mapping table is a **016**
   data-model deliverable). Inclusive-vs-exclusive handling MUST be carried
   explicitly on the posted line so ERPNext's reconciliation re-computes on the
   same basis the POS used. An unmapped `tax_category` is a posting failure that
   lands in the repair queue (017), never a silent default.

3. **Egypt e-invoice / ETA — owned by the Retail Tower ERPNext Connector custom
   Frappe app, gated by 016.** The **Retail Tower ERPNext Connector custom Frappe
   app owns the ERP-side ETA submission adapter** (e-invoice/e-receipt **signing,
   EGS item coding, and ETA API submission**) **if/when approved by the 016 fiscal
   spec**. This is **our custom connector app's responsibility — not ERPNext
   core's.** **Data-Pulse preserves the accepted fiscal payload and does NOT submit
   directly to ETA in v1.** The connector **passes the ETA status / UUID back to
   DP2** for operational visibility (so the dashboard/POS can show submission
   state). DP2 does **NOT** call the ETA API directly (rejected: it would put
   Egyptian regulatory churn inside DP2). Whether ETA is in scope for the initial
   go-live is confirmed in **016**; the ownership decided here (connector custom
   app, not ERPNext core, not DP2) holds regardless.

4. **Rounding policy — line-level to the EGP minor unit; invoice = sum of rounded
   lines.** (Pins the §III / ROADMAP-ERP §3 open gate.) Each line's tax is
   rounded to the **EGP minor unit (2 decimal places, piastres)** at the POS; the
   **invoice total is the SUM of the already-rounded lines.** DP2 preserves
   exactly what the POS computed and printed (§III preserve-as-received). **ERPNext
   is configured for line-level rounding** so its recomputation reconciles to the
   piastre. Result: **the printed receipt and the filed invoice agree exactly.**
   (Invoice-level rounding with residual distribution is **rejected** — it can make
   the receipt's line taxes diverge from the filed invoice.) Money is exact-decimal
   throughout; **no floats** (§III).

5. **Multi-tax composition.** Multiple taxes (e.g. VAT + any service/levy) are
   composed as **explicit, ordered components** on the posted line, each rounded
   to the minor unit at its own step (consistent with item 4), so the composition
   is reproducible and reconcilable. The concrete component set + ordering for
   Egypt v1 is a **016** deliverable; the principle (explicit, ordered,
   line-level-rounded, reproducible) is fixed here.

6. **Fiscal document numbering.** The fiscal/legal document number is owned by
   **ERPNext** (its naming series) and, where ETA assigns an identifier, by the
   **ETA-assigned UUID/long-ID**. DP2 keeps its own `sourceSystem + externalId`
   correlation key (the posting decision's idempotency key) and **stores the
   ERPNext/ETA identifiers as references** — DP2 does **not** mint the fiscal
   number.

7. **Historical immutability.** Posted tax/fiscal documents are **immutable
   historical truth** (§IX). Corrections are **new documents** (credit notes /
   return invoices, per the [posting decision](./posting-decision-record.md)),
   **never edits** of a submitted/filed document. ETA-submitted documents follow
   the same rule (reversal via a new ETA document).

### Constraints honoured

- Money exact-decimal, lossless to the EGP minor unit; no floats (§III).
- POS totals preserved as received; mismatches flagged, never silently rewritten
  (§III).
- Submitted/filed fiscal documents immutable; reversal via new documents.
- Customer-identifying fiscal data (e.g. buyer tax registration) follows §XIV
  data-class discipline — **016** MUST classify these fields.

### Downstream obligations this decision imposes (016)

- Build the `tax_category` → ERPNext Item Tax Template mapping (with
  inclusive/exclusive flag) and the unmapped-category → repair-queue path.
- Define the Egypt v1 tax-component set + ordering, all line-level rounded.
- If/when 016 approves ETA, the **Retail Tower ERPNext Connector custom Frappe
  app** builds the ETA submission adapter and passes ETA status/UUID back to DP2;
  DP2 preserves the accepted fiscal payload and never submits to ETA directly.
  Classify any PII fiscal fields per §XIV.
- Confirm ETA-in-scope-at-go-live (a 016 scoping question; ownership — connector
  custom app, not ERPNext core, not DP2 — is fixed here).

## Sign-off

| Field | Value |
|---|---|
| Status | **SIGNED** |
| Signer | Ahmed Shaaban |
| Date | 2026-06-03 |
