/**
 * InventoryService — 009-US1-ONHAND (T033).
 *
 * The first runtime surface of the Inventory domain: the two READ operations.
 *   - getOnHand          — the derived (compute-on-read) signed SUM of a
 *                          (tenant, store, product)'s movements (FR-003). NO
 *                          materialized balance (R1/plan §10).
 *   - listStockMovements — the movements behind a balance, in a stable order
 *                          (FR-004).
 *
 * Tenant isolation: every query runs inside `runWithTenantContext` (sets
 * `app.current_tenant` in a transaction so RLS is active and fail-closed) —
 * the same primitive 005 reconciliation reuses. NO manual `SET LOCAL`, no new
 * primitive. Store scope is the `WHERE store_id = $1` clause + object-level
 * authz at the controller (0014 has tenant RLS only, no store policy).
 *
 * Compute-on-read SUM: `COALESCE(SUM(quantity), 0)` — over zero rows SUM is
 * NULL, so COALESCE makes an empty key a deterministic "0" (FR-005). The SUM is
 * done in SQL (numeric precision; never fetch-and-sum in JS). On-hand MAY be
 * negative (allow-and-flag, FR-024) — `negativeBalance` flags it.
 *
 * Projection: explicit columns only — the lineage `idempotency_key` and the
 * `source_system`/`external_id` dedup pair are NOT in the contract's
 * `StockMovement` projection and are never returned (§IV).
 *
 * Write operations (createStockMovement / transfer / count / backfill) are
 * authored in 009-US2-MANUAL onward — NOT here.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import { PG_POOL } from "../auth/auth.module";

/** Wire projection of a stock_movements row (contract `StockMovement`, §IV). */
export interface StockMovementBody {
  readonly id: string;
  readonly storeId: string;
  readonly movementType: string;
  readonly quantity: string;
  readonly stockingUnit: string;
  readonly tenantProductRef: string | null;
  readonly reason: string | null;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly saleId: string | null;
  readonly saleLineId: string | null;
  readonly terminalEventRef: string | null;
  readonly transferGroupId: string | null;
  readonly stockCountId: string | null;
  readonly createdBy: string;
}

/** Wire projection of the derived on-hand (contract `OnHand`, FR-003/024). */
export interface OnHandBody {
  readonly storeId: string;
  readonly productId: string;
  readonly quantity: string;
  readonly stockingUnit: string | null;
  readonly negativeBalance: boolean;
}

export interface StockMovementListBody {
  readonly items: readonly StockMovementBody[];
  readonly nextCursor: string | null;
}

/** Raw row shape from the explicit-column SELECT. */
interface MovementRow {
  id: string;
  store_id: string;
  movement_type: string;
  quantity: string;
  stocking_unit: string;
  tenant_product_ref: string | null;
  reason: string | null;
  occurred_at: Date;
  received_at: Date;
  sale_id: string | null;
  sale_line_id: string | null;
  terminal_event_ref: string | null;
  transfer_group_id: string | null;
  stock_count_id: string | null;
  created_by: string;
}

const MOVEMENT_COLUMNS = `
  id, store_id, movement_type, quantity, stocking_unit, tenant_product_ref,
  reason, occurred_at, received_at, sale_id, sale_line_id, terminal_event_ref,
  transfer_group_id, stock_count_id, created_by
`;

function toMovementBody(r: MovementRow): StockMovementBody {
  return {
    id: r.id,
    storeId: r.store_id,
    movementType: r.movement_type,
    quantity: r.quantity,
    stockingUnit: r.stocking_unit,
    tenantProductRef: r.tenant_product_ref,
    reason: r.reason,
    occurredAt: r.occurred_at.toISOString(),
    receivedAt: r.received_at.toISOString(),
    saleId: r.sale_id,
    saleLineId: r.sale_line_id,
    terminalEventRef: r.terminal_event_ref,
    transferGroupId: r.transfer_group_id,
    stockCountId: r.stock_count_id,
    createdBy: r.created_by,
  };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

@Injectable()
export class InventoryService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Derived on-hand for a (tenant, store, product): COALESCE(SUM(quantity), 0).
   * Empty key ⇒ "0" (FR-005). Negative ⇒ negativeBalance=true (FR-024).
   */
  async getOnHand(input: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly productId: string;
  }): Promise<OnHandBody> {
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<OnHandBody> => {
        // Store scope is the WHERE clause + object-level authz at the
        // controller; 0014 has tenant RLS only (no store policy), so no
        // app.current_store GUC is needed.
        // SUM in SQL; COALESCE handles the empty-key (zero-row → NULL) case.
        // stocking_unit is taken from any movement for the key (consistent per
        // product by FR-022); NULL when there are no movements.
        const r = await client.query<{
          quantity: string;
          stocking_unit: string | null;
        }>(
          // ::numeric(19,4)::text gives a uniform wire format ("0.0000" /
          // "7.0000") — the empty-key COALESCE literal and the SUM both render
          // at the column's scale, so a client never sees mixed "0" vs "7.0000".
          `SELECT COALESCE(SUM(quantity), 0)::numeric(19,4)::text AS quantity,
                  MIN(stocking_unit) AS stocking_unit
             FROM stock_movements
            WHERE store_id = $1 AND tenant_product_ref = $2`,
          [input.storeId, input.productId],
        );
        const quantity = r.rows[0]?.quantity ?? "0.0000";
        return {
          storeId: input.storeId,
          productId: input.productId,
          quantity,
          stockingUnit: r.rows[0]?.stocking_unit ?? null,
          negativeBalance: Number(quantity) < 0,
        };
      },
    );
  }

  /**
   * List movements for a (tenant, store) in stable order (occurred_at, id).
   * `productId` set ⇒ that product; omitted ⇒ ad-hoc (NULL-product) movements
   * only (per the contract — ad-hoc entries are listable but roll up to no
   * product on-hand, SC-001 / data-model Entity 2).
   */
  async listStockMovements(input: {
    readonly tenantId: string;
    readonly storeId: string;
    readonly productId?: string | null | undefined;
    readonly limit?: number | undefined;
  }): Promise<StockMovementListBody> {
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<StockMovementListBody> => {
        // productId present → that product; absent → ad-hoc (NULL) movements.
        const productPredicate =
          input.productId != null
            ? "tenant_product_ref = $2"
            : "tenant_product_ref IS NULL";
        const params: unknown[] =
          input.productId != null
            ? [input.storeId, input.productId, limit]
            : [input.storeId, limit];
        const limitParam = input.productId != null ? "$3" : "$2";
        const r = await client.query<MovementRow>(
          `SELECT ${MOVEMENT_COLUMNS}
             FROM stock_movements
            WHERE store_id = $1 AND ${productPredicate}
            ORDER BY occurred_at ASC, id ASC
            LIMIT ${limitParam}`,
          params,
        );
        return {
          items: r.rows.map(toMovementBody),
          nextCursor: null,
        };
      },
    );
  }
}
