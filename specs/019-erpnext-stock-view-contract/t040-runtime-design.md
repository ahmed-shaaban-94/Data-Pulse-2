# 019 T040 — DP2 Bin-View Feed/Report Runtime: Architecture Impact Map

**Status:** DESIGN — owner approval required before code (plan.md: "Needs its own approval + Architecture Impact Map").
**Date:** 2026-06-08
**Spec:** `019-erpnext-stock-view-contract` · **Contract (shipped):** `packages/contracts/openapi/erpnext-connector/stock-view.yaml` (PR #526)
**Constitution:** v3.0.1

> Builds the DP2-side **runtime** for the two 019 operationIds the contract pinned —
> `binViewPullRequests` (feed) + `binViewReportSnapshot` (report) — mirroring the
> shipped **015 posting feed/ack runtime** (`erpnext-posting.controller/service`).
> This is T040. The **017-rewire** that makes the recorded snapshot replace
> `EMPTY_BIN_VIEW` is T041 (separate, follows this). No new `packages/db` table
> (FR-009 — no standing Bin mirror); run-scoped evidence lands in
> `erpnext_reconciliation_run.summary.bin_view_report` (see §3 — corrected from the
> planning docs' `result.detail`, which has no row at report time).

---

## 1. The central design tension (why this is NOT a copy-paste of 015)

The shipped 019 contract and the existing 017 seam speak **different languages**:

| Concern | 017 `ErpnextBinView` (today) | 019 contract (shipped) |
|---|---|---|
| Item key | `tenant_product_ref` (DP2 identity) | `erpnextItemRef` `{doctype:"Item", name}` (ERPNext identity) |
| Quantity | `number` (float) | exact-decimal **string** `^-?[0-9]{1,15}(\.[0-9]{1,6})?$` (§III) |
| Unit | (none) | `stockUom` (REQUIRED — 017 unit-mismatch detection) |
| Shape | `Map<productRef, qty>` | per-item `BinEntry[]` in a `BinViewSnapshotReport` |
| Direction | synchronous pull from a stub | connector PUSHes a report after PULLing a request |

**Two load-bearing gaps the explorer confirmed:**

1. **No reverse resolver.** All existing item resolution is *forward*
   (`tenant_product_ref → erpnext_item_ref`, joining `erpnext_item_map` on
   `tenant_product_id`). The connector reports `erpnextItemRef`; the report runtime
   must resolve it **backward** to `tenant_product_ref` via the confirmed 013 map.
   This method does not exist — T040 adds it (read-only SQL, no schema change).

2. **The `number` quantity is a §III violation waiting to happen.** The 017 seam's
   `ReadonlyMap<string, number>` loses exact decimals. T041 (not T040) will widen
   the seam; T040 records the **string** quantity faithfully into
   `run.summary.bin_view_report` (§3) so no precision is lost at the boundary.

**Scope boundary T040/T041:** T040 builds the feed + report endpoints and records the
report run-scoped. It does **NOT** change `ErpnextBinView` or the processor — a
recorded report sits in `run.summary.bin_view_report` (§3), unread by the
processor until T041 rewires `fetchBinView` to read it. This keeps T040 shippable
and reviewable on its own (the 012 precedent: contract → feed runtime → consumer rewire, each separate).

---

## 2. What T040 builds (in-repo, DP2 `apps/api`)

### 2.1 New module: `apps/api/src/catalog/erpnext-bin-view/` (mirrors `erpnext-posting/`)

```
erpnext-bin-view/
├── erpnext-bin-view.controller.ts   # binViewPullRequests (GET) + binViewReportSnapshot (POST)
├── erpnext-bin-view.service.ts      # feed projection + report recording + O-3 idempotent replay
├── bin-view-request.projection.ts   # project active 014 stock mappings + 017 run intent → BinViewRequest pages
├── dto/snapshot-report.dto.ts       # Zod schema for BinViewSnapshotReport (strict, no body scope §XII)
└── erpnext-bin-view.module.ts       # wires controller + service + ConnectorAuthGuard
```

### 2.2 `binViewPullRequests` (the feed) — mirrors `connectorPullPostings`

- **Guard:** `ConnectorAuthGuard` (scope=connector token + non-disabled registration, 018). Tenant from principal only.
- **Source of "wanted reads":** the open 017 runs needing a Bin view. A run is
  `kind='stock'`, `status='running'`, store has an active 014 `stock` mapping.
  Project one `BinViewRequest` per `(run, store, itemWindow)`:
  - `requestRef` — server-issued opaque uuid (NEW: needs a run-scoped request record; see §3).
  - `storeId`, `erpnextWarehouseRef` (from active 014 map), `runRef` (the 017 run id).
  - `itemWindow` — DP2 windows the warehouse's mapped items into ≤500-item slices
    (the HIGH-fix invariant). v1: a single window (`windowSeq:0`, `maxItems:500`,
    null bounds) if the store has ≤500 confirmed-mapped items; otherwise paginate.
  - `itemCursor` — opaque advanced cursor.
- **Cursor:** mirror 015 — opaque `since`, ordered, idempotent replay, `BinViewPage`
  with `cursor` + `next_page_token`. A stale cursor → `409 snapshot_required`.
- **READ-ONLY:** the pull mutates nothing (idempotent replay).

### 2.3 `binViewReportSnapshot` (the report) — mirrors `connectorAckOutcome`

- **Guard:** `ConnectorAuthGuard`. **`@Idempotent("required")`** (Idempotency-Key header).
- **Body:** `BinViewSnapshotReport` = `{ entries: BinEntry[], readAt }`, strict
  (`additionalProperties:false`), **no `tenant_id`/`storeId`** (§XII; `requestRef` is the path param).
- **Recording:** resolve `requestRef` in tenant scope (cross-tenant → non-disclosing 404).
  For each `BinEntry`: reverse-resolve `erpnextItemRef → tenant_product_ref` (confirmed 013 map);
  preserve the exact-decimal `quantity` **string** + `stockUom`. Write run-scoped
  (see §3 for where). Stamp server-clock `recordedAt`; echo connector `readAt` (§X clock split).
- **O-3 idempotent replay:** same `Idempotency-Key` + same logical report → 200
  `Idempotent-Replayed: true`, echo `RecordedBinView`; different report → 409
  `idempotency_key_conflict`. (Reuses the `IdempotencyInterceptor`; same pattern as 015 ack.)
- **Response:** `RecordedBinView` (201 fresh / 200 replay) — `requestRef`, `runRef`,
  `erpnextWarehouseRef`, `acceptedEntryCount`, `readAt`, `recordedAt`.

---

## 3. Persistence decision (the one real open question for the owner)

The contract requires a **server-issued `requestRef`** that the report binds to, and
a place to record the snapshot run-scoped. FR-009 forbids a standing Bin mirror, but
the feed needs *some* durable handle so a pulled `requestRef` can be validated +
idempotently reported against. Two options:

**Option A — run-scoped request rows (RECOMMENDED).** A small `[GATED]` table
`erpnext_bin_view_request (request_ref, run_id, tenant_id, store_id,
erpnext_warehouse_ref, window_seq, item_cursor, created_at, reported_at)` — NOT a
Bin mirror (no quantities), just the *request* handle + a `reported_at` stamp. The
snapshot *values* land in 017 `result.detail` (or a sibling run-scoped detail row),
honoring FR-009. **Cost:** one `[GATED]` migration (`0022`) — collides with 020/021's
reserved 0022 (#520); resolve numbering at gate time.

**Option B — no new table; derive requestRef deterministically** from `(run_id,
window_seq)` (e.g. a UUIDv5 over the run + window) and store the report directly in
`result.detail`. **Pro:** zero `packages/db` surface, strictly honors "019 touches no
migration." **Con:** no `reported_at` idempotency anchor independent of the 017 result;
replay/conflict detection leans entirely on the `IdempotencyInterceptor` + result rows.

> **DECISION (owner, 2026-06-08): Option B.** No new table; `requestRef` derived
> deterministically (UUIDv5 over `run_id + window_seq`), snapshot recorded in 017
> `result.detail`. T040 touches **ZERO gated surfaces** — pure `apps/api` runtime.
> Idempotency leans on the `IdempotencyInterceptor` + the run-scoped result rows.
> **no quantity/valuation column** (FR-009/§IX); values go to `result.detail`.
>
> **Implications of B locked in:**
> - `requestRef = uuidv5(namespace, `${runId}:${windowSeq}`)` — stable + idempotent
>   across pulls without a request table. The report path re-derives + validates it
>   belongs to a `running` run in the principal's tenant (else non-disclosing 404).
>
> **RECORDING TARGET — `run.summary`, NOT `result.detail` (corrected 2026-06-08).**
> Earlier docs (contract description, data-model §4, the first draft of this file)
> said run-scoped evidence lands in `erpnext_reconciliation_result.detail`. That is
> **wrong for the report-time write** and is corrected here: **at
> `binViewReportSnapshot` time the result rows do not exist yet** — the processor
> CREATES result rows during the compare (`insertResult`, processor.ts:182), which
> in the async T041 model runs *after* the report arrives. So `result.detail` has no
> row to write to at report time. The **`erpnext_reconciliation_run` row exists from
> trigger** and has a nullable `summary JSONB` + `correlation_id` + SELECT/INSERT/
> **UPDATE** RLS. Therefore T040 records the snapshot into
> **`run.summary.bin_view_report`** = `{ entries:[{erpnextItemRef, tenant_product_ref,
> quantity (string), stockUom}], readAt, recordedAt, acceptedEntryCount }`.
>   - **Verified no clobber:** the processor's `complete()` (processor.ts:208) does
>     NOT write `summary` today (counts are returned in-memory only), so `summary` is
>     empty in practice. To stay T041-safe, **both** the report writer (T040) and any
>     future counts writer (T041) MUST merge under a namespaced sub-key via
>     `summary = COALESCE(summary,'{}'::jsonb) || jsonb_build_object('bin_view_report', $x)`
>     — NEVER a bare `summary = $x` overwrite. Counts will live under a sibling key.
>   - **Conscious stretch:** the `summary` column comment scopes it to "counts by
>     mismatch class." A per-item `entries[]` is detail-shaped; namespacing it under
>     `summary.bin_view_report` is the pragmatic Option-B home (no column add = no
>     gate). Payload size: ≤500 items × small objects per window — fine for a pilot;
>     noted so it is not a scale surprise. Still **no money/valuation field** (§IX/FR-009).
> - **DOC RECONCILIATION (PR gate):** before the T040 PR, grep the `result.detail`
>   phrasing across the whole 019 spec family and reconcile to `run.summary.bin_view_report`
>   (lesson: a fact change must propagate across ALL sibling docs, not just this one).

---

## 4. Gated surfaces (require explicit `[GATED]` approval)

| Surface | T040? | Note |
|---|---|---|
| `packages/contracts/openapi/**` | NO | Already shipped (PR #526); T040 builds against it. |
| Migration `0022` (`erpnext_bin_view_request`) | **YES — only if Option A** | Run-scoped request handle, no quantities. Collides w/ 020/021 (#520). |
| `OUTBOX_EVENT_TYPES` | **NO (T040)** / maybe T041 | T040 is request/response HTTP. T041's async rewire may add `erpnext.bin_view.reported`. |
| `worker.module.ts` | NO (T040) / YES (T041) | T040 is api-only. T041 wires the processor to read reports. |
| `package.json` / `.github/**` | NO | No new dep, no CI change. |

**T040 with Option B touches ZERO gated surfaces** (api-only runtime). That's a strong reason to prefer B if owner wants T040 to stay non-gated.

---

## 5. RLS / security posture (§II / §XII)

- Every read/write tenant-scoped via `runWithTenantContext` (`app.current_tenant`,
  fail-closed empty-GUC CASE guard). Connector principal sets the GUC.
- `requestRef` resolves only in the principal's tenant → cross-tenant = non-disclosing 404.
- Scope never body-supplied; strict DTOs; `requestRef` is a path param (un-forgeable).
- Reverse item resolution (`erpnext_item_ref → tenant_product_ref`) runs under tenant RLS — no cross-tenant item leak.

## 6. Test plan (§VI, RED→GREEN, Testcontainers/WSL)

1. **Feed happy path** — running stock run + active 014 map → one `BinViewRequest` page with correct `runRef`/`erpnextWarehouseRef`/`itemWindow`.
2. **Cursor idempotent replay** — same `since` → same page.
3. **`snapshot_required`** — stale cursor → 409.
4. **Report happy path** — POST snapshot → 201 `RecordedBinView`, values recorded run-scoped, `erpnextItemRef` reverse-resolved.
5. **Idempotent replay** — same Idempotency-Key + body → 200 `Idempotent-Replayed`.
6. **Conflict** — same key, different body → 409.
7. **Cross-tenant `requestRef`** — 404 non-disclosing.
8. **Malicious body scope** — `tenant_id`/`storeId` in body → 400 validation_failure.
9. **Exact-decimal preservation** — quantity string round-trips, no float coercion.
10. **Unmapped `erpnextItemRef`** — recorded but flagged (the 017 run will class `erpnext_only`); no crash.
11. **Auth** — non-connector principal (session/pos) → 401.

## 6b. Code-review findings (2026-06-08)

Two parallel reviewers (code + security) ran on the GREEN runtime. Triage (advisor-confirmed):

**Fixed in T040:**
- **[HIGH] Keyset-pagination bug** — `ORDER BY started_at, id` but cursor filters `id > $1`. Run ids are UUIDv4 (`0020` `gen_random_uuid()`), so id-order ≠ started_at-order → runs silently dropped across page boundaries. FIX: `ORDER BY run.id` only (cursor key == sort key). RED test added.
- **[MED] N+1 reverse-resolve** — 500 per-entry item-map queries → batched to one `WHERE erpnext_item_ref = ANY($1::text[])`.
- **[LOW] DTO over-constrains cursor to UUID** — contract says opaque string; relaxed `since` to `z.string().min(1)`.

**FLAGGED, NOT fixed here (own slice — needs owner sign-off):**
- **[HIGH] IdempotencyInterceptor tenant-partition collapse** — VERIFIED real: `idempotency.interceptor.ts:98-101` `tenantId(ctx)` reads only `req.context?.tenantId` (no `principal` fallback); connector routes have no `TenantContextGuard` → partition tenant = `null`; `clientId` = the issuing human admin's `userId` (`connector-registration.service.ts:326`). Cross-tenant key collision if one admin issues credentials in ≥2 tenants. **PRE-EXISTING on shipped 015 ack route.** Not fixed in T040: (a) platform/shared-infra fix on a closed route (own regression + sign-off); (b) the service-level O-3 (requestRef+content, RLS-scoped) is the tenant-safe PRIMARY path; (c) pilot is single-tenant. **TODO: file as a platform issue — owner to confirm (auto-creation blocked by standing rule).**

**Deferred to T041 (noted, not fixed):**
- multi-window `||` overwrite (only v1-safe — one window per run today; the §3 merge-safety claim is window-count-dependent);
- over-broad `FOR UPDATE OF run` (locks all running runs; narrow to the matched row);
- `LIMIT 1` reverse-resolve without `ORDER BY` (nondeterministic if two confirmed maps share an `erpnext_item_ref`).

## 7. Sequence after approval

1. (If Option A) `[GATED]` migration `0022` + schema + migration-spec (append to EXPECTED_MIGRATIONS).
2. RED: write the 11 conformance/integration tests above (failing).
3. GREEN: reverse resolver → feed projection → feed controller → report service (O-3) → report controller → module wiring.
4. `pnpm -r run build` + run the suite in WSL Testcontainers.
5. Code review (subagent + /code-review), then PR (with `[GATED]` callout if Option A).
6. → T041 (017-rewire) → T#4 connector client → T#5 live exercise.
