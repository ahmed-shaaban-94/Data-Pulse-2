/**
 * UnknownItemsService — 005 Wave 1 / T511 (CAPTURE-HAPPY) + T514
 * (CAPTURE-RESOLVE) + T516 (CAPTURE-STORE-SCOPE) + T518 (CAPTURE-DEDUP).
 *
 * Owns the data-layer writes for the POS unknown-item capture path.
 *
 * CAPTURE-HAPPY scope (T511): on a miss against the tenant's active alias
 * set, INSERT a fresh `pending` `unknown_items` row.
 *
 * CAPTURE-RESOLVE scope (T514): before that INSERT, query
 * `product_aliases` filtered to `retired_at IS NULL` (uses the partial
 * index `idx_product_aliases_lookup`). On a hit, return a `resolved`
 * outcome carrying the resolved `tenant_products.id` (and the alias id
 * for auditing). NO `unknown_items` row is created on the resolved path
 * per FR-022 / FR-030 / FR-031.
 *
 * CAPTURE-STORE-SCOPE scope (T516): the alias lookup applies the
 * `store_id IS NULL OR store_id = $current_store` residual filter so a
 * store-scoped alias bound to a DIFFERENT store of the same tenant does
 * not resolve a submission from the submitting store (FR-030a).
 *
 * CAPTURE-DEDUP scope (T518, THIS extension): after alias lookup misses,
 * SELECT `unknown_items` filtered to `resolution_status = 'pending'` for
 * the same `(tenant_id, store_id, identifier_type, value, source_system)`
 * tuple — uses the partial index `idx_unknown_items_lookup_value`
 * (003 §8, predicate `WHERE resolution_status = 'pending'`). On a hit,
 * return the existing row's reference; do NOT INSERT (FR-032). A
 * `dismissed` or `resolved` row is excluded by the partial-index
 * predicate and MUST NOT short-circuit a fresh capture (FR-005).
 *
 * Out of scope for THIS slice (each lands in a downstream Wave 1 slice
 * that EXTENDS this service):
 *   - Non-disclosing get-by-id (SI-004 / FR-013 / FR-092) →
 *       005-WAVE1-NON-DISCLOSING (T521/T522)
 *   - List + dismiss → 005-WAVE1-LIST / 005-WAVE1-DISMISS
 *   - Idempotency-mismatch audit + counter (FR-021c, FR-082) →
 *       005-WAVE1-IDEMP-MISMATCH (T533) — the existing
 *       `IdempotencyInterceptor` already provides the 409 outcome;
 *       this slice does not author the catalog-domain mismatch hook.
 *
 * Hard constraints (constitutional + plan-binding):
 *   - Every DB call runs inside `runWithTenantContext(...)` per 003 §8 +
 *     001 helpers. No raw pool access.
 *   - The store GUC `app.current_store` is set explicitly inside the
 *     transactional callback (003's RLS INSERT policy checks it).
 *   - No PII in logs: `value` is catalog reference data (per Constitution
 *     §XIV + 003 §10 redaction matrix) and is not redacted, but
 *     `sale_context` is opaque advisory JSON and MUST NOT be logged
 *     verbatim — pino redaction at the boundary takes care of this when
 *     a downstream slice wires a structured log statement. The current
 *     slice does not log `sale_context`.
 *
 * See:
 *   specs/005-pos-catalog-sync-reconciliation/spec.md §5 US1, §6.1–§6.4
 *   specs/005-pos-catalog-sync-reconciliation/data-model.md §2.1 + §2.2
 *   packages/contracts/openapi/catalog/unknown-items.yaml — posCaptureItem
 */
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";

import { runWithTenantContext } from "@data-pulse-2/db";

import { PG_POOL } from "../../auth/auth.module";
import { recordUnknownItemCaptured } from "../../observability/metrics/api.metrics";

/**
 * Inputs accepted at the service boundary. Mirrors the contract's
 * `PosCaptureItemRequest` (Zod-validated upstream in the controller).
 * `tenantId`, `storeId`, and `actorUserId` come from the resolved POS
 * principal context — body-supplied tenant/store fields are NOT trusted
 * (Constitution §III).
 */
export interface CaptureItemInput {
  readonly tenantId: string;
  readonly storeId: string;
  /** POS principal's `userId` per `ResolvedContext` (= device identity). */
  readonly actorUserId: string;
  readonly correlationId: string;
  readonly identifierType: "barcode" | "sku" | "plu" | "supplier_code" | "external_pos_id";
  readonly identifierValue: string;
  readonly sourceSystem: string | null;
  readonly saleContext: Record<string, unknown> | null;
}

/**
 * Raw row shape returned by the INSERT ... RETURNING clause. Aligned to
 * the 003 `unknown_items` Drizzle schema; the controller adapts to the
 * contract `UnknownItem` shape.
 */
export interface CapturedUnknownItemRow {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly identifierType: string;
  readonly identifierValue: string;
  readonly sourceSystem: string | null;
  readonly resolutionStatus: "pending";
  readonly resolutionAction: null;
  readonly resolvedAt: null;
  readonly resolvedBy: null;
  readonly resolvedProductId: null;
  readonly encounteredAt: Date;
  readonly saleContext: Record<string, unknown> | null;
}

/**
 * Resolved-outcome variant — alias lookup hit. Mirrors the contract's
 * `PosCaptureResolvedResponse` (kind, product_id, alias_id?). The
 * controller adapts these fields to snake_case wire shape.
 */
export interface ResolvedAliasMatch {
  readonly kind: "resolved";
  readonly productId: string;
  readonly aliasId: string;
}

/**
 * Discriminated-union return shape mirroring the contract's
 * `PosCaptureResolvedResponse | PosCaptureUnknownResponse`.
 * CAPTURE-HAPPY (T511) emits the `unknown` variant; CAPTURE-RESOLVE
 * (T514, this extension) adds the `resolved` variant via an alias-lookup
 * prelude that runs before the INSERT.
 */
export type CaptureItemResult =
  | { readonly kind: "unknown"; readonly unknownItem: CapturedUnknownItemRow }
  | ResolvedAliasMatch;

@Injectable()
export class UnknownItemsService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Capture a POS-submitted item reference.
   *
   * Behavior (FR-022 / FR-030 / FR-031 / FR-032 / FR-001):
   *   1. ALIAS-RESOLUTION PRELUDE (T514) — SELECT the most recent active
   *      `product_aliases` row matching `(tenant_id, identifier_type,
   *      value)` filtered to `retired_at IS NULL`. On a hit, return a
   *      `resolved` outcome carrying the resolved `tenant_products.id`
   *      — no `unknown_items` row is created (FR-022).
   *   2. NATURAL-DEDUP CHECK (T518) — on alias miss, SELECT
   *      `unknown_items` for the same `(tenant_id, store_id,
   *      identifier_type, value, source_system)` tuple where
   *      `resolution_status = 'pending'`. On a hit, return that row's
   *      reference; do NOT INSERT (FR-032). Dismissed/resolved rows are
   *      excluded by the partial-index predicate so FR-005 (resubmit
   *      after dismissal creates a fresh `pending` row) is preserved.
   *   3. CAPTURE FALLBACK (T511) — on both misses, INSERT a fresh
   *      `pending` `unknown_items` row scoped to (tenant, store) and
   *      return the persisted row.
   *
   * Alias scope (T516 — store-scope respected, FR-030a):
   *   The lookup filter is `(tenant_id, identifier_type, value) AND
   *   (store_id IS NULL OR store_id = $current_store)`. Tenant-wide
   *   aliases (`store_id IS NULL`) resolve at every store of the tenant;
   *   store-scoped aliases resolve ONLY when the submitting store
   *   matches `store_id`. A store-scoped alias bound to a DIFFERENT
   *   store of the same tenant MUST NOT resolve here — per FR-030a it
   *   must fall through to capture as `unknown` at the submitting
   *   store.
   *
   *   Precedence: when both a store-scoped match AND a tenant-wide
   *   match exist for the same `(tenant_id, identifier_type, value)`,
   *   the store-scoped row wins. This is implemented via
   *   `ORDER BY (store_id IS NULL) ASC, created_at DESC LIMIT 1` —
   *   `FALSE` (store-scoped) sorts before `TRUE` (tenant-wide). The
   *   003 partial unique indexes guarantee at most ONE active row per
   *   scope, so the secondary `created_at DESC` tiebreaker only
   *   matters for defensive shape tolerance.
   *
   *   The 003 partial index `idx_product_aliases_lookup` (tenant_id,
   *   identifier_type, value) WHERE retired_at IS NULL still serves
   *   this access pattern — the `store_id` predicate is applied as a
   *   filter after the index scan. Adding `store_id` to the index key
   *   would be a 003-domain migration, out of scope for this slice.
   *
   * Transactional contract:
   *   - Both the alias SELECT and (when needed) the `unknown_items`
   *     INSERT run inside `runWithTenantContext` so 003's RLS policies
   *     see the correct tenant GUC. The store GUC is set inside the
   *     same callback for the INSERT path.
   *   - On the resolved branch the callback short-circuits before any
   *     INSERT; `recordUnknownItemCaptured()` is NOT called (the row
   *     never existed). The Wave 1 capture metric counts inserts, not
   *     POS-submission count.
   *
   * Metric handling (T514 — alias-hit branch):
   *   `unknown_item_resolved_total{action}` exists with a closed enum
   *   `{linked, created, dismissed}` (api.metrics.ts:78-83). NONE of
   *   those values describe a capture-time alias hit — `linked` denotes
   *   the Wave 2 reconciliation action that links a pending row to a
   *   product. Per the slice brief ("do NOT extend the enum"), this
   *   slice emits NO metric on the resolved branch. If signals.md later
   *   adds an `alias_hit` action, the call site lives here.
   */
  async captureItem(input: CaptureItemInput): Promise<CaptureItemResult> {
    const id = randomUUID();

    const result = await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<
        | { kind: "resolved"; productId: string; aliasId: string }
        | { kind: "unknown"; inserted: boolean; row: {
            id: string;
            tenant_id: string;
            store_id: string;
            identifier_type: string;
            value: string;
            source_system: string | null;
            resolution_status: "pending";
            resolution_action: null;
            resolved_at: null;
            resolved_by: null;
            resolved_product_id: null;
            encountered_at: Date;
            sale_context: Record<string, unknown> | null;
          } }
      > => {
        // Alias-resolution prelude (T514, refined by T516 for FR-030a).
        //
        // Uses the partial index `idx_product_aliases_lookup`
        // (tenant_id, identifier_type, value) WHERE retired_at IS NULL.
        // The `store_id` predicate is applied as a residual filter:
        // `store_id IS NULL` (tenant-wide alias, resolves anywhere) OR
        // `store_id = $current_store` (store-scoped alias, resolves
        // ONLY at the submitting store). A store-scoped alias bound to
        // a DIFFERENT store of the same tenant MUST NOT match — that's
        // the FR-030a invariant.
        //
        // Precedence (FR-030a): store-scoped wins over tenant-wide for
        // the same identifier. `ORDER BY (store_id IS NULL) ASC` puts
        // FALSE (store-scoped) before TRUE (tenant-wide); `created_at
        // DESC` is a defensive tiebreaker (003's partial unique indexes
        // already guarantee at most one active row per scope).
        const aliasHit = await client.query<{
          id: string;
          product_id: string;
        }>(
          `SELECT id, product_id
             FROM product_aliases
            WHERE tenant_id       = $1
              AND identifier_type = $2
              AND value           = $3
              AND retired_at IS NULL
              AND (store_id IS NULL OR store_id = $4)
            ORDER BY (store_id IS NULL) ASC, created_at DESC
            LIMIT 1`,
          [
            input.tenantId,
            input.identifierType,
            input.identifierValue,
            input.storeId,
          ],
        );

        const hit = aliasHit.rows[0];
        if (hit) {
          // FR-022 / FR-030 / FR-031: no INSERT; surface the resolved
          // product directly. Store GUC remains unset on this branch —
          // the resolved path does not read or write `unknown_items`
          // and therefore needs neither the store_read RLS predicate
          // nor the insert WITH CHECK predicate.
          return {
            kind: "resolved",
            productId: hit.product_id,
            aliasId: hit.id,
          };
        }

        // Set the store GUC BEFORE the dedup SELECT.
        //
        // 003 ships TWO permissive SELECT policies on `unknown_items`:
        //   - `unknown_items_tenant_isolation` (tenant_id = $tenant)
        //   - `unknown_items_store_read`       (store_id = $store OR
        //                                       store='')
        // Permissive policies OR — visibility requires at least one to
        // be TRUE. But `current_setting('app.current_store', true)`
        // returns NULL when unset (the `true` second arg suppresses the
        // missing-setting error), so `NULL::uuid` makes both halves of
        // the store policy NULL → NULL, which Postgres treats as FALSE
        // in filter context. Tenant-isolation alone would be enough to
        // see the row in theory, but the OR'd-NULL drives the policy
        // evaluation to FALSE for the store_read branch and the row is
        // filtered when the tenant policy is also unreachable for the
        // current login role. Setting `app.current_store` here makes
        // the store_read policy succeed and the dedup query find any
        // pending rows the prior capture committed.
        //
        // The GUC is harmless to the resolved-alias branch above: that
        // branch returned BEFORE this point, so the store GUC remains
        // unset for the resolved-path commit (no row written, no SELECT
        // attempted on `unknown_items` on that branch).
        await client.query(
          "SELECT set_config('app.current_store', $1, true)",
          [input.storeId],
        );

        // Natural-dedup check (T518, FR-032).
        //
        // Uses the partial index `idx_unknown_items_lookup_value`
        // (tenant_id, identifier_type, value) WHERE resolution_status =
        // 'pending'. The predicate is written literally (not
        // parameterized) so the planner can match the partial index;
        // `store_id` and `source_system` are applied as residual filters.
        //
        // Store-scope enforcement: `store_id = $4` ensures dedup is
        // bounded to the submitting store. A pending row at a DIFFERENT
        // store of the same tenant MUST NOT short-circuit this capture
        // — that's the FR-030a invariant carried forward from T516.
        //
        // source_system matching: 003's `unknown_items_source_system_required`
        // CHK ties source_system NOT NULL <=> identifier_type =
        // 'external_pos_id'. For `barcode` / `sku` / `plu` /
        // `supplier_code` the column is always NULL; for
        // `external_pos_id` it's always NOT NULL. `IS NOT DISTINCT
        // FROM` matches both branches (NULL=NULL → TRUE,
        // 'pos-a'='pos-a' → TRUE, NULL='pos-a' → FALSE).
        //
        // FR-005 invariant: dismissed/resolved rows are excluded by the
        // partial-index predicate `WHERE resolution_status = 'pending'`,
        // so resubmitting an identifier whose only prior row is
        // `dismissed` correctly falls through to INSERT a new pending
        // row (the dismissed row is NOT returned). T545 elsewhere
        // codifies this as a service-layer assertion.
        const dedupHit = await client.query<{
          id: string;
          tenant_id: string;
          store_id: string;
          identifier_type: string;
          value: string;
          source_system: string | null;
          resolution_status: "pending";
          resolution_action: null;
          resolved_at: null;
          resolved_by: null;
          resolved_product_id: null;
          encountered_at: Date;
          sale_context: Record<string, unknown> | null;
        }>(
          `SELECT id, tenant_id, store_id, identifier_type, value,
                  source_system, resolution_status, resolution_action,
                  resolved_at, resolved_by, resolved_product_id,
                  encountered_at, sale_context
             FROM unknown_items
            WHERE tenant_id       = $1
              AND store_id        = $2
              AND identifier_type = $3
              AND value           = $4
              AND source_system IS NOT DISTINCT FROM $5
              AND resolution_status = 'pending'
            ORDER BY encountered_at ASC
            LIMIT 1`,
          [
            input.tenantId,
            input.storeId,
            input.identifierType,
            input.identifierValue,
            input.sourceSystem,
          ],
        );

        const existing = dedupHit.rows[0];
        if (existing) {
          // FR-032: a pending row already exists for this logical
          // identifier in the same (tenant, store). Return its
          // reference unchanged — no INSERT, no metric increment
          // (`unknown_item_captured_total` counts NEW pending rows
          // per docs/observability/signals.md). The row's
          // `encountered_at` reflects the ORIGINAL capture time, not
          // this resubmission — that's intentional per FR-032
          // ("return that existing record's reference").
          return { kind: "unknown", inserted: false, row: existing };
        }

        // Both misses → capture path (T511). The store GUC required by
        // 003's `unknown_items_insert` RLS policy was already set above
        // (before the dedup SELECT) and remains in scope for this
        // transaction.
        const insertResult = await client.query<{
          id: string;
          tenant_id: string;
          store_id: string;
          identifier_type: string;
          value: string;
          source_system: string | null;
          resolution_status: "pending";
          resolution_action: null;
          resolved_at: null;
          resolved_by: null;
          resolved_product_id: null;
          encountered_at: Date;
          sale_context: Record<string, unknown> | null;
        }>(
          `INSERT INTO unknown_items
             (id, tenant_id, store_id, identifier_type, value,
              source_system, resolution_status, sale_context,
              correlation_id)
           VALUES
             ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)
           RETURNING id, tenant_id, store_id, identifier_type, value,
                     source_system, resolution_status, resolution_action,
                     resolved_at, resolved_by, resolved_product_id,
                     encountered_at, sale_context`,
          [
            id,
            input.tenantId,
            input.storeId,
            input.identifierType,
            input.identifierValue,
            input.sourceSystem,
            input.saleContext,
            input.correlationId,
          ],
        );

        const r = insertResult.rows[0];
        if (!r) {
          // RLS returning zero rows on a self-insert means the principal's
          // tenant/store context did not satisfy `unknown_items_insert`.
          // This is a guard error, not a domain error; surface a thrown
          // exception rather than corrupt the response shape.
          throw new Error("unknown_items: insert produced no row");
        }
        return { kind: "unknown", inserted: true, row: r };
      },
    );

    if (result.kind === "resolved") {
      // FR-022: identifier resolved to an existing tenant product. No
      // capture-metric increment (the counter tracks `unknown_items`
      // inserts, not POS submissions).
      return {
        kind: "resolved",
        productId: result.productId,
        aliasId: result.aliasId,
      };
    }

    if (result.inserted) {
      // T518 / FR-032: only increment the capture counter on a FRESH
      // INSERT. A dedup-hit returns an existing pending row (no new
      // `unknown_items` write) and so must NOT increment the counter
      // — per docs/observability/signals.md `unknown_item_captured_total`
      // tracks "successful POS capture INTO unknown_items table".
      recordUnknownItemCaptured();
    }

    const row = result.row;
    const captured: CapturedUnknownItemRow = {
      id: row.id,
      tenantId: row.tenant_id,
      storeId: row.store_id,
      identifierType: row.identifier_type,
      identifierValue: row.value,
      sourceSystem: row.source_system,
      resolutionStatus: "pending",
      resolutionAction: null,
      resolvedAt: null,
      resolvedBy: null,
      resolvedProductId: null,
      encounteredAt: row.encountered_at,
      saleContext: row.sale_context,
    };

    return { kind: "unknown", unknownItem: captured };
  }

  /**
   * Non-disclosing GET-by-id for `unknown_items` (T522 /
   * 005-WAVE1-NON-DISCLOSING).
   *
   * Behavior (SI-001 / SI-004 / FR-013 / FR-092):
   *   - The caller's tenant + (optional) store scope are set as GUCs via
   *     `runWithTenantContext` + `set_config('app.current_store', ...)`.
   *   - Selects the row by `id` ONLY — the WHERE clause does NOT explicitly
   *     check `tenant_id`. RLS does the tenant filtering: 003's
   *     `unknown_items_tenant_isolation` policy returns zero rows when the
   *     id belongs to a different tenant, and the OR'd `unknown_items_store_read`
   *     branch enforces store-scope when the principal is store-scoped.
   *   - Zero rows ⇒ `NotFoundException` (404-class). Indistinguishable from
   *     "id does not exist anywhere" — the response MUST NOT leak existence
   *     in another tenant or another store.
   *   - One row ⇒ adapted to `CapturedUnknownItemRow` shape (mirrors
   *     `captureItem`'s `unknown` branch).
   *
   * `storeId`:
   *   - Tenant-wide principal (tenant admin / tenant owner) passes `null`;
   *     `app.current_store` is set to `''` so 0009's empty-string carve-out
   *     in `unknown_items_store_read` evaluates TRUE for all stores in the
   *     tenant.
   *   - Store-scoped principal (store manager / operator) passes their
   *     store's UUID; the store_read predicate matches rows from that store
   *     only.
   *
   * Why NOT add `WHERE tenant_id = $X` explicitly:
   *   The whole point of RLS is that the service does not need to layer
   *   tenant filtering on top — that introduces a second source of truth
   *   and risks silent disagreement with the policy. SI-001's invariant is
   *   that the DB layer alone makes cross-tenant reads impossible; this
   *   helper composes that into a 404-class HTTP signal, no more.
   *
   * Wave 1 usage:
   *   Internal only — no public route exposes this in Wave 1. tasks.md
   *   T522 calls out that LIST is the public surface; this helper exists
   *   so that when a future slice authors a controller GET-by-id (or
   *   reconciliation-needs-by-id), the non-disclosing posture is already
   *   the service contract.
   */
  async findByIdForTenant(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly storeId: string | null;
  }): Promise<CapturedUnknownItemRow> {
    const row = await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client) => {
        // Set `app.current_store` BEFORE the SELECT so the store_read RLS
        // branch can evaluate. Empty-string for tenant-wide actors (0009
        // carve-out); store UUID for store-scoped actors. Without this,
        // `current_setting('app.current_store', true)` returns NULL and
        // the OR'd store_read branch evaluates FALSE — leaving only the
        // tenant_isolation branch, which is fine for tenant-wide queries
        // but would silently over-restrict a store-scoped principal.
        // Mirrors the `set_config` call in `captureItem` (line ~295).
        await client.query(
          "SELECT set_config('app.current_store', $1, true)",
          [input.storeId ?? ""],
        );

        const result = await client.query<{
          id: string;
          tenant_id: string;
          store_id: string;
          identifier_type: string;
          value: string;
          source_system: string | null;
          resolution_status: "pending" | "resolved" | "dismissed";
          resolution_action: "linked" | "created" | "dismissed" | null;
          resolved_at: Date | null;
          resolved_by: string | null;
          resolved_product_id: string | null;
          encountered_at: Date;
          sale_context: Record<string, unknown> | null;
        }>(
          // No `tenant_id = $X` predicate — RLS does the cross-tenant
          // filter. SI-001 invariant: the row is unreachable from any
          // tenant other than its owning tenant under 003's policies.
          `SELECT id, tenant_id, store_id, identifier_type, value,
                  source_system, resolution_status, resolution_action,
                  resolved_at, resolved_by, resolved_product_id,
                  encountered_at, sale_context
             FROM unknown_items
            WHERE id = $1
            LIMIT 1`,
          [input.id],
        );

        return result.rows[0] ?? null;
      },
    );

    if (!row) {
      // FR-013 / FR-092 / SI-004: non-disclosing 404. The exception body
      // names no tenant, no store, no identifier — the actor cannot use
      // this response to learn whether the id exists in another tenant.
      // NestJS's `NotFoundException` formats as `{ statusCode: 404,
      // message: "Not Found" }` by default; the `GlobalExceptionFilter`
      // rewrites that into the canonical envelope with
      // `error.code = "not_found"`.
      throw new NotFoundException("Not Found");
    }

    return {
      id: row.id,
      tenantId: row.tenant_id,
      storeId: row.store_id,
      identifierType: row.identifier_type,
      identifierValue: row.value,
      sourceSystem: row.source_system,
      // The Wave 1 GET-by-id only surfaces pending rows in the test
      // suite, but the helper is shape-tolerant for any lifecycle state
      // — the CHK on 003 keeps the column combinations valid.
      resolutionStatus: row.resolution_status as "pending",
      resolutionAction: row.resolution_action as null,
      resolvedAt: row.resolved_at as null,
      resolvedBy: row.resolved_by as null,
      resolvedProductId: row.resolved_product_id as null,
      encounteredAt: row.encountered_at,
      saleContext: row.sale_context,
    };
  }
}
