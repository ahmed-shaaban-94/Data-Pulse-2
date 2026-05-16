# Redaction Matrix: Catalog Foundation (003)

**Ref**: 003-catalog-foundation (T312)
**Author**: Catalog Foundation spec author
**Date**: 2026-05-16
**Constitution**: v3.0.0

> **Documentation-only artifact.** This matrix records planned obligations
> for the Catalog Foundation feature. It does **not** implement runtime
> redaction. No serializer, transport, or log-emitting code is authored
> by this slice. Every rule below is a **planned obligation** (use of
> "must", "will", and "required") that the future implementation slices
> (Phases 2–6 of `tasks.md`) and any log-emitting code path that touches
> catalog data MUST honor at the logger boundary.

---

## Changelog

- **2026-05-16** — Initial matrix (003-T312). Source: spec §11
  (Constitution Alignment, §14 row), plan §III row §VII / §XIV,
  data-model §6 (`product_aliases`), §7 (`unknown_items.sale_context`),
  tasks.md §T312. Companion to the platform-wide policy in
  `.specify/memory/redaction-matrix.md`; this artifact restates and
  specializes that policy for catalog entities.

> **Add-only by default.** Adding a sensitive catalog field or a new
> redaction class to this matrix is a documentation change. **Removing**
> a redaction rule (i.e., "this catalog field is now safe to log raw")
> is a change-proposal PR per Constitution §VIII (Reproducible &
> Versioned Releases) — it requires explicit reviewer approval and a
> written justification. Silent removal is a review-blocking defect.

---

## 1. Scope

This artifact covers logger-boundary redaction obligations for every
field, log site, and metric label introduced by the Catalog Foundation
feature (003). It governs catalog-touching log emissions on the API,
worker, audit emitter, and any future ingestion adapter. It is the
catalog-specialized companion to the platform-wide matrix at
`.specify/memory/redaction-matrix.md`; where the two overlap, the
platform matrix's rules also apply, and the stricter rule wins.

The two fields requiring named treatment in this artifact (per T312
acceptance) are:

- **`product_aliases.value`** — the alias literal (barcode digits, SKU
  string, PLU digits, supplier code, or external POS identifier).
- **`external_pos_id` values** — POS-supplied opaque identifiers stored
  in `product_aliases.value` when `identifier_type = 'external_pos_id'`
  and also surfaced in `unknown_items.value` and any future ingestion
  surface that carries a `sourceSystem + externalId` pair.

This matrix operationalizes Constitution v3.0.0:

- **§7 Observable Systems** — structured logs MUST NOT contain
  secrets, tokens, PII, or full payloads; metrics MUST NOT carry PII or
  unbounded-cardinality labels.
- **§14 PII & Data Lifecycle Discipline** — logger-boundary redaction
  is mandatory; classification drives logging, retention, export, and
  right-to-erasure.

Per spec §11 (Constitution Alignment, §14 row) and plan §III (§XIV
row), catalog data is **business class** (not PII), but alias values,
supplier codes, and external POS ids are sensitive business
identifiers that MUST respect logger-boundary redaction. Plan §III
adds: "no full alias values in logs at INFO+; redact at WARN/ERROR".
This matrix encodes that obligation field-by-field and log-site by
log-site.

> Out of scope: response-body shaping (uniform error envelope per
> Constitution §III), API contract response shapes (Constitution §IV;
> contract YAML is not authored by 003), and audit-record on-disk
> contents (governed by the audit pipeline's own classification
> rules — which, for catalog fields, defer to this matrix).

---

## 2. Data Classification

Every persisted catalog field that may be encountered in a log
statement is classified below. Classification drives the redaction
column in §3.

Classification values (consistent with the platform matrix):
**PII** · **payment** · **business** · **business-sensitive** ·
**public** · **credential**.

> **`business-sensitive` is a strict subset of `business`**: safe to
> persist and to use as a join key, but MUST NOT appear in raw form in
> INFO / WARN / ERROR logs or in metric labels. Use this classification
> for opaque identifiers that, while not PII, are operationally
> sensitive (e.g., an external POS id that, combined with a tenant id,
> identifies a customer's POS rowset).

### 2.1 Catalog fields requiring redaction (`business-sensitive`)

| Field / property | Classification | Rationale |
|---|---|---|
| `product_aliases.value` (any `identifier_type`) | business-sensitive | Raw alias literal. Per spec §11 / plan §III, no full alias values in logs at INFO+. Required redaction regardless of `identifier_type`. |
| `product_aliases.value` where `identifier_type = 'barcode'` | business-sensitive | Raw barcode digits. MUST NOT appear in INFO/WARN/ERROR logs. |
| `product_aliases.value` where `identifier_type = 'sku'` | business-sensitive | Raw tenant SKU. MUST NOT appear in INFO/WARN/ERROR logs. |
| `product_aliases.value` where `identifier_type = 'plu'` | business-sensitive | Raw PLU digits. MUST NOT appear in INFO/WARN/ERROR logs. |
| `product_aliases.value` where `identifier_type = 'supplier_code'` | business-sensitive | Raw supplier code. MUST NOT appear in INFO/WARN/ERROR logs. |
| `product_aliases.value` where `identifier_type = 'external_pos_id'` | business-sensitive | POS-supplied external identifier. Strictest treatment in this matrix. MUST NOT appear in INFO/WARN/ERROR logs. MUST NOT appear in metric labels. |
| `product_aliases.source_system` | business-sensitive | The POS system label paired with `external_pos_id`. Safe to log alone (low cardinality, no customer data), but MUST NOT be logged co-located with the raw `value` such that the pair reconstructs an external POS identity. |
| `unknown_items.value` (any `identifier_type`) | business-sensitive | Same rationale as `product_aliases.value` — this is the unresolved-alias literal that triggered the unknown-item event. Same redaction obligations apply. |
| `unknown_items.source_system` | business-sensitive | Same rationale as `product_aliases.source_system`. |
| `unknown_items.sale_context` (jsonb) | business-sensitive | Per data-model §7 closing note, "must be **redacted at all logger boundaries** per Constitution §14. It may contain POS-supplied sale identifiers that constitute business-confidential data. It must never appear in INFO, WARN, or ERROR logs." |

### 2.2 Catalog fields safe to log (`business`)

| Field / property | Classification | Rationale |
|---|---|---|
| `tenant_id` | business | Not a secret; required for support and debugging. Safe as a log field. Per platform matrix §3.4 and FR-B-006, never a metric label. |
| `store_id` | business | Same rationale as `tenant_id`. |
| `correlation_id` | business | End-to-end trace identifier. Required field. |
| `request_id` | business | Per-request identifier. Required field. |
| `product_id` (UUID) | business | Internal identifier; safe to log; not a metric label. |
| `tenant_product_id`, `store_override_id`, `product_alias_id`, `unknown_item_id` | business | Internal UUIDs; safe to log; not a metric label. |
| `identifier_type` (`barcode` / `sku` / `plu` / `supplier_code` / `external_pos_id`) | business | Low-cardinality enum; safe to log and to use as a metric label. |
| `resolution_status` (`pending` / `linked` / `created` / `dismissed`) | business | Low-cardinality enum; safe as a log field and metric label. |
| `operation` (`create` / `update` / `retire` / `adopt` / `resolve`) | business | Audit-event operation; safe to log. |
| `outcome` (`ok` / `conflict` / `denied` / `not_found`) | business | Low-cardinality result class; safe to log and to use as a metric label. |
| `error_class` (the *class* name only, not the message) | business | Safe; message may echo raw values and is redacted separately. |
| `currency_code` (ISO 4217) | business | Public reference data; safe to log and as a metric label. |
| `currency`-coded amount (when emitted at all) | business | Exact-decimal monetary value bound to a `currency_code`. Log only where required by audit (per Constitution §III), never as a metric label. |
| `from_value` / `to_value` for price-change audit events | business | Exact-decimal monetary values. Logged within audit emitter rows only, paired with `currency_code` and `correlation_id`. |
| `occurredAt` / `receivedAt` / `processedAt` / `businessDate` / `sourceClockAt` / `voidedAt` / `refundedAt` | business | Temporal facts per Constitution §10. Safe to log. |

### 2.3 Reclassification rule

A catalog field MAY move **up** the sensitivity ladder at any time
(business → business-sensitive). A field MUST NOT move **down** the
ladder without a change-proposal PR per the add-only rule in the
changelog. Where this matrix and the platform matrix
(`.specify/memory/redaction-matrix.md`) disagree, the **stricter** rule
applies.

---

## 3. Log Boundary Rules

Redaction MUST be enforced **at the logger boundary** — at the pino
transport serializer and at the OpenTelemetry log exporter — **not at
call sites**. A call-site redaction pattern
(`logger.info({ alias_value: '***' })`) is a review-blocking defect
even when correct: it is neither testable in aggregate nor
enforceable as policy.

The "Redaction method" column names a planned obligation. No
serializer module is authored by this slice; the catalog
implementation slices and the platform observability slice (feature
004 Track B) MUST register serializers consistent with this matrix
before any of these log sites emits in production.

> **Severity rule (planned obligation, all rows below)**: regardless
> of log level (INFO, WARN, ERROR), raw barcode, SKU, PLU, supplier
> code, alias value, `external_pos_id` value, and
> `unknown_items.sale_context` MUST NOT appear in the structured log
> output. WARN and ERROR log records that reference an alias MUST use
> a redacted or fingerprinted representation per §3.2 below. INFO is
> the strictest level — it MUST NOT emit even fingerprints of these
> values unless the fingerprint itself is documented as required for
> correlation.

### 3.1 Catalog log sites

| Log / emit site | Level(s) | Fields emitted (allowed) | Fields redacted (MUST NOT emit raw) | Redaction method (planned obligation) |
|---|---|---|---|---|
| Request log (catalog read / write routes) | INFO | `request_id`, `tenant_id` (when established), `store_id` (when established), `route`, `method`, `status_class`, `latency_ms`, `correlation_id` | Raw `product_aliases.value`, raw `unknown_items.value`, raw `external_pos_id`, raw `source_system + value` pair, raw barcode / SKU / PLU / supplier code, full request body, full response body, raw `Authorization` / `Cookie` headers | Platform request-log serializer (defined by feature 004 Track B) MUST drop the request/response body by default and MUST NOT echo any `value` field from a catalog payload at INFO. |
| Validation failure handler (catalog endpoints) | WARN | `request_id`, `tenant_id` (when established), `route`, `method`, `field_path` (e.g., `body.alias.value`, `body.aliases[0].value` — the **path**, not the value), `rule` (e.g., `length_1_200`, `identifier_type_valid`, `source_system_required`, `external_pos_id_no_store_scope`), `outcome: validation_error` | The rejected `value` itself, the rejected `source_system`, raw request body | `validation-failure.serializer.ts` (per platform matrix §4) — the rejected value is dropped; only the field path and the rule name survive. |
| Duplicate-alias conflict handler | WARN | `request_id`, `tenant_id`, `store_id` (when applicable), `identifier_type`, `conflict_scope` (`tenant_wide` / `external_pos_id` / `store_scoped`), `existing_product_id` (UUID), `incoming_product_id` (UUID), `correlation_id`, `outcome: conflict` | Raw alias `value`, raw `source_system` paired with raw `value`, raw external POS id | Custom catalog `alias-conflict.serializer.ts` (planned, future): emits `value_fingerprint` (SHA-256 hex of `(tenant_id || ':' || identifier_type || ':' || value || (source_system ? ':' || source_system : ''))`, lowercased, salted with a deployment-wide salt resolved by the platform observability slice) and `value_length` (integer character count). MUST NOT emit `value` or any prefix/suffix of it at WARN. |
| Catalog write (create / update / retire) error handler | ERROR | `request_id`, `tenant_id`, `store_id` (when applicable), `route`, `operation` (`create` / `update` / `retire` / `adopt`), `entity` (`tenant_product` / `store_override` / `product_alias` / `unknown_item`), `error_class`, `error_code`, `correlation_id`, `outcome` | Raw alias `value`, raw `external_pos_id`, raw `source_system` paired with raw `value`, raw request body, raw exception message if it could echo the raw value (use error class + sanitized summary) | Catalog write-error serializer (planned). When the error originates from a constraint violation that contains the value in the DB error text (e.g., partial unique index violation), the serializer MUST replace the value substring with `<redacted>` and emit `value_fingerprint` separately. |
| Catalog lookup failure handler (no product found) | WARN | `request_id`, `tenant_id`, `store_id` (when applicable), `identifier_type`, `lookup_scope` (`store_override` / `tenant_catalog` / `external_pos_id`), `outcome: not_found`, `correlation_id` | Raw alias `value`, raw `external_pos_id`, raw `source_system` paired with raw `value` | Catalog lookup serializer (planned): emits `value_fingerprint` and `value_length` only; raw value never emitted. |
| Unknown-item event emitter (audit + log) | INFO (audit) / WARN (if escalated) | `unknown_item_id`, `tenant_id`, `store_id`, `identifier_type`, `source_system` (when present, alone — never paired with raw `value`), `encountered_at`, `resolution_status`, `correlation_id` | Raw `unknown_items.value`, raw `unknown_items.sale_context`, raw alias literal that triggered the unknown-item event, raw POS receipt identifiers from `sale_context` | Unknown-item serializer (planned). For the unresolved literal, emits `value_fingerprint` (per §3.2). For `sale_context`, the entire field is dropped at the logger boundary regardless of level (per data-model §7). |
| Unknown-item resolution handler | INFO (audit) | `unknown_item_id`, `tenant_id`, `store_id`, `resolved_by` (actor id), `resolution_action` (`linked` / `created` / `dismissed`), `resolved_product_id` (when applicable, UUID), `correlation_id`, `outcome` | Raw `unknown_items.value`, raw `sale_context`, raw alias literal | Same as unknown-item event emitter; resolution row contains no raw alias material. |
| Price-change audit emitter | INFO (audit) | `actor_id` (or anonymous-actor sentinel), `tenant_id`, `store_id` (when applicable), `entity` (`tenant_product` / `store_override`), `target_id`, `from_value`, `to_value`, `currency_code`, `correlation_id`, `occurred_at`, `outcome` | Raw alias `value` (irrelevant to price change but never echoed if present in payload), raw request body | Audit-event serializer (per platform matrix §4 "Audit event emitter"). |
| Adoption (Global Product Index → Tenant Catalog) audit emitter | INFO (audit) | `actor_id`, `tenant_id`, `source_global_product_id` (UUID), `tenant_product_id` (UUID), `operation: adopt`, `correlation_id`, `occurred_at`, `outcome` | Raw alias `value` if propagated from the global record, raw request body | Audit-event serializer. Adopted alias values follow the standard `product_aliases.value` rule — never raw in logs. |
| Domain log (catalog service layer, INFO traces) | INFO | `tenant_id`, `store_id`, `entity`, `operation`, `correlation_id`, `outcome`, internal UUIDs | Raw `product_aliases.value`, raw `external_pos_id`, raw `source_system + value` pair, raw `sale_context` | Domain-log serializer (planned). Service-layer code MUST construct log records using internal UUIDs and operation enums; the raw value object MUST NOT cross the logger boundary at INFO. |
| Worker failure handler (future POS sync / ingestion) | ERROR | `correlation_id`, `tenant_id`, `store_id`, `job_name`, `queue_name`, `attempt`, `error_class`, `error_code`, `outcome` | Full job payload (PII-suspect per platform matrix), raw alias `value`, raw `external_pos_id`, raw `source_system + value` pair, raw exception message if it could echo the raw value | Worker-failure serializer (per platform matrix §4 "Worker failure handler"); for catalog jobs, the same `value_fingerprint` rule as §3.2 applies. |
| RLS context failure handler (catalog tables) | ERROR | `request_id`, `route`, `method`, `tenant_id` (if any was attempted), `query_class` (parameterized SHA, no values), `outcome: rls_context_failure` | Raw query text, raw query parameters (which may include alias values), raw request body | RLS-failure serializer (per platform matrix §4). The parameterized-SHA discipline ensures alias values inside query parameters never reach the log store. |

### 3.2 Fingerprint and masking conventions (planned obligation)

Where a log site needs an identifier for correlation but MUST NOT
emit the raw alias value, the following representations are
acceptable. Each is a **planned obligation** for the future
serializer to implement; no implementation lives in this slice.

- **`value_fingerprint`** — SHA-256 hex digest of
  `(tenant_id || ':' || identifier_type || ':' || value || (source_system ? ':' || source_system : ''))`
  using a deployment-wide salt resolved by the platform observability
  slice. Lowercased hex; 64 characters. Deterministic per
  `(tenant, identifier_type, value, source_system)`; not reversible.
- **`value_length`** — Integer character count of the raw value.
  Useful for "value too short" / "value too long" investigations
  without leaking the literal.
- **Masked value** — Acceptable only where operator support
  documentation explicitly requires partial visibility (e.g., last 4
  characters of a long external POS id). When used, the masking
  policy MUST be: first 0 characters + last 4 characters,
  remaining characters replaced with `*`, with a minimum total
  length of 8 (shorter values are emitted as `<redacted>`). Masked
  values MUST NOT be used in metric labels.
- **`<redacted>` sentinel** — Default when no other representation
  is documented for the log site.

The fingerprint salt is a credential per the platform matrix §3.1
(treated as a secret) and is not logged. The fingerprint algorithm
choice is a planned obligation; this matrix does not author the
implementation.

### 3.3 Hard rules at every catalog log site

1. **No raw alias values, ever.** Raw `product_aliases.value`, raw
   `external_pos_id` values, raw barcode digits, raw SKU strings,
   raw PLU digits, raw supplier codes, and raw `unknown_items.value`
   MUST NOT appear in INFO, WARN, or ERROR log records. This holds
   regardless of how the value entered the log call (positional
   argument, structured field, exception message, stack-frame
   local, or query parameter).
2. **No full request or response bodies by default.** Catalog
   request and response bodies are PII-suspect for redaction
   purposes (per platform matrix §3.3) because they may contain
   alias values, and MUST be dropped at the logger boundary.
3. **No `source_system + value` co-location at WARN/ERROR.** When a
   log row references an `external_pos_id`, it MUST NOT carry both
   the raw `source_system` label and the raw `value` in the same
   structured record. Either `value` is replaced with
   `value_fingerprint`, or the `source_system` is dropped, or both.
4. **No raw `sale_context`, ever.** Per data-model §7, the
   `unknown_items.sale_context` jsonb field MUST NOT appear in any
   log record at any level. The serializer drops the entire field
   regardless of the call site's structure.
5. **Errors are summaries, not value-echoing strings.** When a
   constraint violation, validation error, or DB-engine error text
   contains the raw alias value (e.g., a partial unique index name
   formatted with the offending value), the serializer MUST replace
   the value substring with `<redacted>` and emit
   `value_fingerprint` separately. Stack traces are allowed; frame
   local-variable values are not.
6. **Logger boundary is the only redactor.** A code review that
   spots `logger.info({ alias_value: '...' })` or
   `logger.warn(\`alias '${value}' conflicts\`)` in a catalog code
   path MUST be rejected even if the serializer would catch it —
   the call site is itself a policy violation.

### 3.4 Anonymous-actor pattern

Where a catalog audit event has no authenticated actor (e.g., an
adoption performed by a background reconciliation worker before
actor context is established), use the `system` sentinel as
`actor_id`. Never emit a placeholder containing any alias material
(e.g., `actor_id: "adopting alias 1234567890"` is forbidden).

---

## 4. Metrics labels (Constitution §7)

Catalog signals are listed in spec §9 and plan §III (§VII row). The
four catalog metrics are:

- `unknown_item_rate`
- `duplicate_alias_conflict_rate`
- `catalog_lookup_failure_rate`
- `reconciliation_mismatch_rate` (named only; emission lands with
  the future POS sync feature)

The following metric-label rules are planned obligations of this
matrix:

- **No raw alias values in any metric label.** Raw
  `product_aliases.value`, raw `external_pos_id` values, raw
  barcode / SKU / PLU / supplier-code values, and raw
  `unknown_items.value` MUST NOT appear as a metric label on any
  catalog metric.
- **No `source_system` paired with raw `value` in metric labels.**
  Even though `source_system` alone is low-cardinality and safe as a
  label, it MUST NOT be combined with the raw value as a label
  pair.
- **No `value_fingerprint` in metric labels.** Fingerprints are
  high-cardinality (one per distinct alias value) and would push
  metrics beyond cardinality budgets. Fingerprints belong in logs,
  not in metric labels.
- **Allowed catalog metric labels** (low-cardinality enums and
  established business identifiers): `tenant_id` is **never** a
  metric label (per platform matrix §3.4 and FR-B-006);
  `identifier_type`, `conflict_scope`, `lookup_scope`,
  `resolution_status`, `resolution_action`, `outcome`,
  `error_class`, `currency_code`, `source_system` (alone, not
  paired with `value`), `route`, `method`, `status_class` are the
  acceptable label set. Concrete per-metric label sets are recorded
  in the future observability signals catalogue (out of scope for
  this matrix).
- **No PII labels.** This matrix does not introduce PII; the rule is
  restated for completeness because catalog labels often look like
  business data and reviewers MUST verify each label is in the
  allowed set above before a metric ships.

---

## 5. Retention Windows (Constitution §14)

Logs are operational signals, distinct from audit records and from
the catalog tables themselves. Their retention is operational and
governed by the log store, not by application-layer sweeps.

| Classification | Retention window (logs only) | Sweep mechanism |
|---|---|---|
| Credential (should never appear in catalog logs; if accidentally captured) | **Purge on detection** — incident response | Logger-side detection alert; manual purge from the log store; rotate the affected secret |
| business-sensitive (alias values, `external_pos_id` values, `sale_context`) | **n/a in raw form** — MUST NOT reach the log store. Fingerprints (`value_fingerprint`) and lengths follow the **business** retention window | Logger boundary blocks raw forms; fingerprints are subject to log-store retention |
| business (request_id, tenant_id, store_id, correlation_id, internal UUIDs, identifier_type, operation, outcome, currency_code, temporal facts) | **90 days** default (consistent with platform matrix §5) | Log-store retention policy (vendor-side) |
| Public | No constraint | — |

Audit-record retention for catalog auditable events (spec §8) is
**not** governed by this matrix — audit records are kept indefinitely
with the `product_aliases.value` field tombstoned on erasure where
required, per Constitution §13 and §14. The catalog tables
themselves (`product_aliases`, `unknown_items`, etc.) follow the
soft-delete pattern via `retired_at` / `resolution_status`, per
data-model §6 and §7 and plan §III (§XIV row).

Where this matrix's retention windows differ from the platform
matrix, the **shorter** window applies.

---

## 6. Right-to-Erasure Posture (Constitution §14)

- **Catalog data is business class, not PII.** Right-to-erasure is
  primarily a concern for PII-bearing entities (e.g., user accounts,
  customer profiles). It is not a primary concern of this feature.
  This section is included so the matrix is complete and so the
  catalog-layer obligations are explicit.
- **Erasure flow**: deferred to the platform-wide PII / erasure
  feature (not 003). When erasure of a downstream PII subject also
  requires redaction of catalog log entries that carry that
  subject's `external_pos_id` (e.g., a customer-linked POS id), the
  catalog log serializers MUST honor the standard fingerprint /
  redaction rules in §3 so that future log emissions automatically
  omit the raw identifier; historical log entries within retention
  are operationally erasable via log-store tooling (vendor-side).
- **Audit immutability preserved by**: tombstoning the
  `product_aliases.value` field (and `unknown_items.value` /
  `unknown_items.sale_context`) in audit rows where they appear,
  per Constitution §13. This matrix does not implement that
  tombstoning; it specifies the obligation.
- **Catalog table soft-delete**: `product_aliases.retired_at`,
  `unknown_items.resolution_status` are the operational soft-delete
  surfaces (per data-model §6, §7). Soft-deletion of an alias does
  NOT retroactively redact past log emissions about that alias;
  retention (§5) is the mechanism that bounds historical exposure.
- **Cross-border / data-residency posture**: single region (current
  default; consistent with platform matrix §6). Multi-region MUST
  revisit this section before catalog data crosses a region
  boundary.

---

## 7. How catalog code paths reference this matrix

Every catalog log site authored by a future implementation slice
(Phases 2–6 of `tasks.md`) MUST reference this artifact:

- **Catalog service layer** (`apps/api`, future, gated): pino
  transport for catalog routes MUST register a serializer for
  `product_aliases.value`, `unknown_items.value`,
  `unknown_items.sale_context`, and `external_pos_id` consistent
  with §3.1 above. The serializer registrations MUST be row-by-row
  traceable to §3.1.
- **Catalog audit emitter** (future, gated): MUST honor §3.1
  "Unknown-item event emitter", "Price-change audit emitter", and
  "Adoption audit emitter" rows. The audit pipeline emits no raw
  alias values.
- **Catalog metrics registration** (future, gated): MUST honor §4.
  Concrete label sets per metric are recorded in the future
  observability signals catalogue; this matrix gates which labels
  are admissible.
- **Future POS sync worker** (gated, downstream feature): MUST
  honor §3.1 "Worker failure handler" row plus the platform matrix
  §4 worker rules. Ingestion adapters MUST never log a raw POS
  payload at INFO/WARN/ERROR.
- **POS app** (separate repository, contract-only consumer): out of
  scope of this matrix. The POS app's logger discipline is governed
  by its own redaction policy; the SaaS contract surface MUST NOT
  return raw alias material in error envelopes that the POS app
  would log verbatim.

---

## 8. Open Questions

Each must be resolved before a catalog log site emits in production.
Until resolved, the safer default applies (treat as redacted).

1. **Fingerprint salt scope** — platform-wide salt vs per-tenant
   salt for `value_fingerprint`. Trade-off: per-tenant prevents
   cross-tenant fingerprint joinability (safer); platform-wide
   simplifies operator dashboards. Inherits from platform matrix
   §8 open question 3 (`email_fingerprint` salting). Owner: platform
   observability slice (feature 004 Track B). Until set, the
   stricter per-tenant default applies for catalog fingerprints.
2. **Masked-value visibility for `external_pos_id`** — operator
   support may need a last-4 mask for `external_pos_id` debugging.
   Owner: catalog implementation slice (Phase 4 of tasks.md). Until
   set, the `<redacted>` sentinel applies.
3. **Audit-row tombstoning trigger** — the precise event that
   causes catalog audit rows to have `value` tombstoned. Owner:
   downstream PII / erasure feature. Until set, catalog audit rows
   retain `value` (per spec §8 / Constitution §13 insert-only).
4. **Catalog metric label set authority** — the per-metric
   admissible label sets for the four catalog metrics (spec §9) are
   recorded outside this matrix in a future observability signals
   catalogue. Owner: platform observability slice. Until that
   catalogue exists, this matrix's §4 rules bound what is
   admissible.

---

## 9. Validation against spec / plan / data-model

| Source | Constraint | Implemented at | Status |
|---|---|---|---|
| spec §11 (Constitution Alignment, §14 row) | "alias supplier codes and external POS ids must respect logger-boundary redaction" | §2.1, §3.1 (all rows), §3.3 rule 1 | covered |
| plan §III (§VII row) | "No PII in labels" | §4 (metric label rules) | covered |
| plan §III (§XIV row) | "no full alias values in logs at INFO+; redact at WARN/ERROR" | §3 prologue (severity rule), §3.1 (all rows), §3.3 rule 1 | covered |
| data-model §6 (`product_aliases`) | `value`, `source_system`, `identifier_type` semantics | §2.1, §3.1 (rows referencing `product_aliases`) | covered |
| data-model §7 (`unknown_items`) closing note | "`sale_context` ... must never appear in INFO, WARN, or ERROR logs" | §2.1 row for `sale_context`, §3.3 rule 4 | covered |
| tasks.md T312 | "Covers `product_aliases.value` and `external_pos_id` values at logger boundaries (INFO / WARN / ERROR levels per Constitution §14)" | §1 (Scope), §2.1, §3 prologue, §3.1 (all rows) | covered |

---

## 10. Validation against Constitution v3.0.0

- **§7 Observable Systems**: §3 enforces no secrets / tokens / PII /
  full payloads in logs for catalog code paths; §4 enforces no PII
  and no high-cardinality values in metric labels. Covered.
- **§14 PII & Data Lifecycle Discipline**: §2 establishes
  catalog-specific classification (business-sensitive subclass for
  alias values and `external_pos_id`); §5 sets retention windows;
  §6 documents right-to-erasure posture; §3 establishes
  logger-boundary redaction as the mandatory control. Covered.
- **§13 Auditability & Provenance**: §3.4 establishes the
  anonymous-actor pattern for catalog audit events; §3.1 audit
  rows constrain audit-record log contents to omit raw alias
  material. Covered.
- **§8 Reproducible & Versioned Releases**: §1 changelog block +
  §2.3 reclassification rule preserve auditability of policy
  changes. Covered.

---

*End of catalog redaction matrix. Documentation-only artifact;
no runtime redaction is implemented by this slice.*
