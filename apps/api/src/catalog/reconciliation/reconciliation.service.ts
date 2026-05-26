/**
 * ReconciliationService — 005-WAVE2-LINK-HAPPY (T621).
 *
 * Implements the tenant-admin reconciliation surface: linking a pending
 * unknown item to an existing, active tenant product. This service owns
 * the three-effect transaction described in FR-053:
 *   1. INSERT product_aliases — binds the unknown item's identifier to the
 *      target product.
 *   2. UPDATE unknown_items   — marks the item resolved (monotonic per FR-004).
 * Both effects commit atomically inside a single `runWithTenantContext` call.
 * On any error the entire transaction rolls back; no partial state is persisted.
 *
 * Returned discriminated union:
 *   {kind: "ok";               row: UnknownItemRow}
 *   {kind: "not_found"}        — unknown item absent (RLS/tenant filter) or
 *                                 product absent
 *   {kind: "already_reconciled"} — item is already resolved/dismissed
 *   {kind: "alias_conflict"}   — product_aliases unique index violated (23505)
 *   {kind: "target_unavailable"} — target product exists but is retired (FR-051)
 *
 * The controller maps these to HTTP status codes per FR-040 / FR-092.
 *
 * Race safety:
 *   SELECT ... FOR UPDATE on the unknown_items row prevents a concurrent
 *   dismiss from running between our existence check and the UPDATE, which
 *   would otherwise leave a ghost product_aliases row (the transaction rolls
 *   back, but the lock prevents the race entirely).
 *
 * RLS + GUC wiring (matches UnknownItemsService pattern):
 *   `runWithTenantContext` sets `app.current_tenant` via `set_config`.
 *   `app.current_store` is set explicitly inside the callback so the
 *   `unknown_items_store_read` RLS policy branch is satisfied.
 *
 * Spec anchors: FR-040, FR-053, FR-080, FR-081.
 * OpenAPI: packages/contracts/openapi/catalog/unknown-items.yaml
 *   operationId: tenantAdminLinkUnknownItem
 */
import {
  Inject,
  Injectable,
} from "@nestjs/common";
import type { Pool } from "pg";

import { runWithTenantContext } from "@data-pulse-2/db";

import { PG_POOL } from "../../auth/auth.module";
import { recordUnknownItemResolved } from "../../observability/metrics/api.metrics";

// Re-export the common row shape so the controller does not need a separate
// import from unknown-items.service.ts (avoids cross-module coupling).
export interface UnknownItemRow {
  readonly id: string;
  readonly tenantId: string;
  readonly storeId: string;
  readonly identifierType: string;
  readonly identifierValue: string;
  readonly sourceSystem: string | null;
  readonly resolutionStatus: "pending" | "resolved" | "dismissed";
  readonly resolutionAction: "linked" | "created" | "dismissed" | null;
  readonly resolvedAt: Date | null;
  readonly resolvedBy: string | null;
  readonly resolvedProductId: string | null;
  readonly encounteredAt: Date;
  readonly saleContext: Record<string, unknown> | null;
}

export type LinkResult =
  | { kind: "ok"; row: UnknownItemRow }
  | { kind: "not_found" }
  | { kind: "already_reconciled" }
  | { kind: "alias_conflict" }
  | { kind: "target_unavailable" };

@Injectable()
export class ReconciliationService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Link a pending unknown item to an existing tenant product.
   *
   * Steps (inside a single transaction):
   *   1. SELECT unknown_items WHERE id=$unknownItemId FOR UPDATE
   *      — acquires a row-level lock for the transaction duration.
   *      RLS + store GUC filter means a cross-tenant or cross-store row
   *      returns 0 rows.
   *   2. Discriminate: 0 rows → not_found | non-pending → already_reconciled
   *   3. SELECT tenant_products WHERE id=$productId
   *      — fetch target and check retired_at: absent (0 rows) → not_found
   *        (RLS-filtered cross-tenant or non-existent UUID); retired
   *        (retired_at IS NOT NULL) → target_unavailable per FR-051.
   *   4. INSERT product_aliases — catch PG error 23505 → alias_conflict
   *   5. UPDATE unknown_items SET resolution_status='resolved' WHERE
   *      id=$unknownItemId AND resolution_status='pending'
   *      — rowCount=0 is impossible (FOR UPDATE locked pending row), but
   *        guard is kept for defensive correctness.
   */
  async linkUnknownItem(input: {
    readonly tenantId: string;
    readonly storeId: string | null;
    readonly unknownItemId: string;
    readonly productId: string;
    readonly actorUserId: string;
  }): Promise<LinkResult> {
    const result = await runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<LinkResult> => {
        // Set app.current_store GUC — required by the
        // unknown_items_store_read RLS policy (same pattern as
        // UnknownItemsService.dismissUnknownItem).
        await client.query(
          "SELECT set_config('app.current_store', $1, true)",
          [input.storeId ?? "*"],
        );

        // Step 1+2: lock the unknown_items row and discriminate lifecycle.
        const lockResult = await client.query<{
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
          // T626 race-safety verification: this FOR UPDATE lock prevents the
          // FR-052 monotonicity race exercised by link-already-reconciled.spec.ts.
          `SELECT id, tenant_id, store_id, identifier_type, value,
                  source_system, resolution_status, resolution_action,
                  resolved_at, resolved_by, resolved_product_id,
                  encountered_at, sale_context
             FROM unknown_items
            WHERE id = $1
              FOR UPDATE`,
          [input.unknownItemId],
        );

        const existing = lockResult.rows[0];

        if (!existing) {
          return { kind: "not_found" };
        }
        if (existing.resolution_status !== "pending") {
          return { kind: "already_reconciled" };
        }

        // Step 3: confirm target product exists; discriminate retired separately
        // so the controller can map retired -> 409 target_unavailable (FR-051)
        // while absent stays 404 non-disclosing (FR-092 / SI-001).
        const productCheck = await client.query<{
          id: string;
          retired_at: Date | null;
        }>(
          `SELECT id, retired_at
             FROM tenant_products
            WHERE id         = $1
              AND tenant_id  = $2
            LIMIT 1`,
          [input.productId, input.tenantId],
        );

        const productRow = productCheck.rows[0];
        if (!productRow) {
          return { kind: "not_found" };
        }
        if (productRow.retired_at !== null) {
          return { kind: "target_unavailable" };
        }

        // Step 4: INSERT product_aliases — unique constraint 23505 surfaces
        // as alias_conflict. store_id carries the item's store to preserve
        // the store-scoped partial unique index semantics (FR-040).
        // source_system is NULL for barcode/sku/plu/supplier_code rows per
        // the product_aliases_source_system_required check in 0007_catalog.sql.
        try {
          await client.query(
            `INSERT INTO product_aliases
               (tenant_id, product_id, identifier_type, value,
                source_system, store_id, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              input.tenantId,
              input.productId,
              existing.identifier_type,
              existing.value,
              existing.source_system,
              existing.store_id,
              input.actorUserId,
            ],
          );
        } catch (err: unknown) {
          // PostgreSQL unique-violation: 23505
          if (
            typeof err === "object" &&
            err !== null &&
            "code" in err &&
            (err as { code: unknown }).code === "23505"
          ) {
            return { kind: "alias_conflict" };
          }
          throw err;
        }

        // Step 5: UPDATE unknown_items — monotonicity guard keeps
        // resolution_status='pending' in the WHERE to be defensive.
        // The FOR UPDATE lock means rowCount=0 here indicates a logic
        // error (not a race), so we treat it as already_reconciled.
        const updateResult = await client.query<{
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
          `UPDATE unknown_items
              SET resolution_status   = 'resolved',
                  resolution_action   = 'linked',
                  resolved_at         = now(),
                  resolved_by         = $2,
                  resolved_product_id = $3
            WHERE id                = $1
              AND resolution_status = 'pending'
           RETURNING id, tenant_id, store_id, identifier_type, value,
                     source_system, resolution_status, resolution_action,
                     resolved_at, resolved_by, resolved_product_id,
                     encountered_at, sale_context`,
          [input.unknownItemId, input.actorUserId, input.productId],
        );

        const updated = updateResult.rows[0];
        if (!updated) {
          // FOR UPDATE lock + 'pending' status was confirmed at the top of
          // this transaction (see step 2 above). Reaching this branch means
          // the alias INSERT succeeded but the unknown_items UPDATE matched
          // zero rows — a logic error per the comment at the start of
          // step 5. Throw to abort the transaction and roll back the alias
          // INSERT rather than committing inconsistent state.
          throw new Error(
            "reconciliation.linkUnknownItem invariant: unknown_items UPDATE returned 0 rows after FOR UPDATE lock + pending check",
          );
        }

        return {
          kind: "ok",
          row: {
            id: updated.id,
            tenantId: updated.tenant_id,
            storeId: updated.store_id,
            identifierType: updated.identifier_type,
            identifierValue: updated.value,
            sourceSystem: updated.source_system,
            resolutionStatus: updated.resolution_status,
            resolutionAction: updated.resolution_action,
            resolvedAt: updated.resolved_at,
            resolvedBy: updated.resolved_by,
            resolvedProductId: updated.resolved_product_id,
            encounteredAt: updated.encountered_at,
            saleContext: updated.sale_context,
          },
        };
      },
    );

    if (result.kind === "ok") {
      // FR-081: increment the resolved counter on successful link.
      recordUnknownItemResolved({ action: "linked" });
    }

    return result;
  }
}
