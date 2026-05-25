/**
 * UnknownItemsService — 005 Wave 1 / T511 (CAPTURE-HAPPY) + T514 (CAPTURE-RESOLVE).
 *
 * Owns the data-layer writes for the POS unknown-item capture path.
 *
 * CAPTURE-HAPPY scope (T511): on a miss against the tenant's active alias
 * set, INSERT a fresh `pending` `unknown_items` row.
 *
 * CAPTURE-RESOLVE scope (T514, THIS extension): before that INSERT, query
 * `product_aliases` filtered to `retired_at IS NULL` (uses the partial
 * index `idx_product_aliases_lookup`). On a hit, return a `resolved`
 * outcome carrying the resolved `tenant_products.id` (and the alias id
 * for auditing). NO `unknown_items` row is created on the resolved path
 * per FR-022 / FR-030 / FR-031.
 *
 * Out of scope for THIS slice (each lands in a downstream Wave 1 slice
 * that EXTENDS this service):
 *   - Submitting-store scope on alias lookup (FR-030a) →
 *       005-WAVE1-CAPTURE-STORE-SCOPE (T515/T516)
 *   - Natural dedup of pending rows (FR-032) →
 *       005-WAVE1-CAPTURE-DEDUP (T517/T518)
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
import { Inject, Injectable } from "@nestjs/common";
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
   * Behavior (FR-022 / FR-030 / FR-031 / FR-001):
   *   1. ALIAS-RESOLUTION PRELUDE (T514) — SELECT the most recent active
   *      `product_aliases` row matching `(tenant_id, identifier_type,
   *      value)` filtered to `retired_at IS NULL`. On a hit, return a
   *      `resolved` outcome carrying the resolved `tenant_products.id`
   *      — no `unknown_items` row is created (FR-022).
   *   2. CAPTURE FALLBACK (T511) — on a miss, INSERT a fresh `pending`
   *      `unknown_items` row scoped to (tenant, store) and return the
   *      persisted row.
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
        | { kind: "unknown"; row: {
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
          // product directly. Store GUC not set because no write occurs.
          return {
            kind: "resolved",
            productId: hit.product_id,
            aliasId: hit.id,
          };
        }

        // Miss → capture path (T511). Set the store GUC required by
        // 003's `unknown_items_insert` RLS policy.
        await client.query(
          "SELECT set_config('app.current_store', $1, true)",
          [input.storeId],
        );

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
        return { kind: "unknown", row: r };
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

    recordUnknownItemCaptured();

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
}
