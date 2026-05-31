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
 * Write path (009-US2-MANUAL, T044):
 *   - createStockMovement — append a manual inbound / outbound / adjustment
 *     (write-off = reason-coded outbound, FR-002). Append-only (FR-001): one
 *     INSERT, never an UPDATE/DELETE. Tenant / store / actor are resolved
 *     server-side from the principal + path — NEVER the body (FR-052/§XII; the
 *     controller's strict Zod DTO rejects any such body key). The movement's
 *     `stockingUnit` MUST match the product's ESTABLISHED unit — the unit its
 *     existing movements were recorded in (there is no catalog stocking-unit
 *     column; the first movement establishes it). A mismatch is a typed
 *     `CrossUnitError` → 400 (FR-022). `adjustment` requires a `reason`. Each
 *     successful create writes ONE audit event in the SAME transaction (audit
 *     and state cannot diverge — the 005 catalog write idiom). On-hand MAY go
 *     negative (allow-and-flag, FR-024) — never rejected here.
 *
 * Outbox: the create path emits audit-in-transaction ONLY (mirroring the
 * shipped 005 catalog write). An async outbox event for inventory movements is
 * a DEFERRED, [GATED] follow-up — it needs a new `INVENTORY_MOVEMENT_*` type
 * registered in `OUTBOX_EVENT_TYPES` (packages/db/**, a forbidden path outside
 * this slice's allowed_files; same pattern as the 008 `sale.captured` deferral).
 *
 * Transfer / count / backfill writes are authored in 009-US5/US6/US4 — NOT here.
 */
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { runWithTenantContext } from '@data-pulse-2/db';
import { newId } from '@data-pulse-2/shared';
import type { Pool, PoolClient } from 'pg';

import { PG_POOL } from '../auth/auth.module';

/** The set of manually-creatable movement types (contract enum, FR-002). */
export const MANUAL_MOVEMENT_TYPES = ['inbound', 'outbound', 'adjustment'] as const;
export type ManualMovementType = (typeof MANUAL_MOVEMENT_TYPES)[number];

/**
 * Raised when a movement's `stockingUnit` ≠ the product's established unit
 * (FR-022). The controller maps it to a 400 ValidationFailure. Carries both
 * units for a non-leaky, actionable message.
 */
export class CrossUnitError extends BadRequestException {
  constructor(
    public readonly expectedUnit: string,
    public readonly suppliedUnit: string,
  ) {
    super(
      `stockingUnit '${suppliedUnit}' does not match the product's stocking unit '${expectedUnit}'`,
    );
  }
}

/** Server-resolved + body-validated input to createStockMovement (FR-052). */
export interface CreateStockMovementInput {
  /** Resolved from the principal — never the body. */
  readonly tenantId: string;
  /** Resolved from the path — never the body. */
  readonly storeId: string;
  /** Resolved from the principal — never the body. */
  readonly userId: string;
  readonly movementType: ManualMovementType;
  /** SIGNED exact-decimal quantity string, in `stockingUnit`. */
  readonly quantity: string;
  readonly stockingUnit: string;
  readonly tenantProductRef?: string | null | undefined;
  readonly reason?: string | null | undefined;
  /** Business-event time; defaults to now() server-side when omitted. */
  readonly occurredAt?: string | null | undefined;
  readonly saleId?: string | null | undefined;
  readonly saleLineId?: string | null | undefined;
  readonly terminalEventRef?: string | null | undefined;
}

const AUDIT_ACTION_MOVEMENT_CREATE = 'inventory.movement.create';
const AUDIT_TARGET_TYPE_MOVEMENT = 'stock_movement';

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
        const quantity = r.rows[0]?.quantity ?? '0.0000';
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
          input.productId != null ? 'tenant_product_ref = $2' : 'tenant_product_ref IS NULL';
        const params: unknown[] =
          input.productId != null
            ? [input.storeId, input.productId, limit]
            : [input.storeId, limit];
        const limitParam = input.productId != null ? '$3' : '$2';
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

  /**
   * Append a manual movement (inbound / outbound / adjustment). Append-only:
   * one INSERT inside one `runWithTenantContext` transaction, plus one audit
   * event in the SAME transaction. Returns the persisted `toBody` projection.
   *
   * Validation (all server-side; the body never carries tenant/store/actor):
   *   - sign agrees with type (FR-022): inbound>0, outbound<0, adjustment≠0;
   *   - adjustment requires a non-empty reason (FR-012);
   *   - the supplied stockingUnit matches the product's ESTABLISHED unit, if the
   *     product already has movements (FR-022) — first movement / ad-hoc
   *     null-product establishes its own unit, no prior to compare against.
   * On-hand MAY go negative — never rejected (allow-and-flag, FR-024).
   */
  async createStockMovement(input: CreateStockMovementInput): Promise<StockMovementBody> {
    // ---- Pre-DB validation -------------------------------------------------
    if (!MANUAL_MOVEMENT_TYPES.includes(input.movementType)) {
      // write-off is a reason-coded outbound, NOT a type (FR-002); transfer /
      // count_correction are produced by their own operations only.
      throw new BadRequestException(
        `movementType must be one of ${MANUAL_MOVEMENT_TYPES.join(', ')}`,
      );
    }
    const qty = Number(input.quantity);
    if (!Number.isFinite(qty) || qty === 0) {
      throw new BadRequestException('quantity must be a non-zero number');
    }
    if (input.movementType === 'inbound' && qty < 0) {
      throw new BadRequestException('inbound quantity must be positive');
    }
    if (input.movementType === 'outbound' && qty > 0) {
      throw new BadRequestException('outbound quantity must be negative');
    }
    const reason =
      typeof input.reason === 'string' && input.reason.trim().length > 0
        ? input.reason.trim()
        : null;
    if (input.movementType === 'adjustment' && reason === null) {
      throw new BadRequestException('adjustment requires a reason');
    }
    const stockingUnit = input.stockingUnit.trim();
    if (stockingUnit.length === 0) {
      throw new BadRequestException('stockingUnit is required');
    }

    const tenantProductRef = input.tenantProductRef ?? null;
    const movementId = newId();
    const auditId = newId();

    return runWithTenantContext(
      this.pool,
      { tenantId: input.tenantId, isPlatformAdmin: false },
      async (client): Promise<StockMovementBody> => {
        // ---- Cross-unit check (FR-022) -----------------------------------
        // The product's established unit is the unit of its existing movements
        // at this store (no catalog stocking-unit column). Skip for ad-hoc
        // null-product and for a product's very first movement.
        if (tenantProductRef !== null) {
          await this.assertUnitMatchesEstablished(
            client,
            input.storeId,
            tenantProductRef,
            stockingUnit,
          );
        }

        // ---- Append-only INSERT ------------------------------------------
        // tenant_id / store_id / created_by are the server-resolved values
        // (principal + path), never the body. occurred_at defaults to now()
        // when omitted; received_at defaults in the schema (security clock).
        const inserted = await client.query<MovementRow>(
          `INSERT INTO stock_movements
             (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
              tenant_product_ref, reason, occurred_at, sale_id, sale_line_id,
              terminal_event_ref, created_by)
           VALUES
             ($1, $2, $3, $4, $5::numeric(19,4), $6, $7, $8,
              COALESCE($9::timestamptz, now()), $10, $11, $12, $13)
           RETURNING ${MOVEMENT_COLUMNS}`,
          [
            movementId,
            input.tenantId,
            input.storeId,
            input.movementType,
            input.quantity,
            stockingUnit,
            tenantProductRef,
            reason,
            input.occurredAt ?? null,
            input.saleId ?? null,
            input.saleLineId ?? null,
            input.terminalEventRef ?? null,
            input.userId,
          ],
        );
        const row = inserted.rows[0];
        if (!row) {
          throw new Error('InventoryService.createStockMovement: INSERT returned no row');
        }

        // ---- Audit event in the SAME transaction (FR-013, SC-007) --------
        // Atomic with the movement INSERT: a failure on either rolls both back.
        // No outbox emit here (deferred [GATED] follow-up — see header).
        await client.query(
          `INSERT INTO audit_events
             (id, actor_user_id, tenant_id, action, target_type, target_id, metadata)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            auditId,
            input.userId,
            input.tenantId,
            AUDIT_ACTION_MOVEMENT_CREATE,
            AUDIT_TARGET_TYPE_MOVEMENT,
            row.id,
            '{}',
          ],
        );

        return toMovementBody(row);
      },
    );
  }

  /**
   * Throw `CrossUnitError` if the product already has movements at the store in
   * a stocking unit different from `suppliedUnit` (FR-022). Runs on the same
   * RLS-active client as the insert.
   */
  private async assertUnitMatchesEstablished(
    client: PoolClient,
    storeId: string,
    tenantProductRef: string,
    suppliedUnit: string,
  ): Promise<void> {
    const r = await client.query<{ stocking_unit: string }>(
      `SELECT stocking_unit FROM stock_movements
        WHERE store_id = $1 AND tenant_product_ref = $2
        ORDER BY received_at ASC, id ASC
        LIMIT 1`,
      [storeId, tenantProductRef],
    );
    const established = r.rows[0]?.stocking_unit;
    if (established !== undefined && established !== suppliedUnit) {
      throw new CrossUnitError(established, suppliedUnit);
    }
  }
}
