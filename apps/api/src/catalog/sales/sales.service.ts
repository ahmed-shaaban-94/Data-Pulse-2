/**
 * SalesService — 008 US1 capture (T035).
 *
 * Creates the immutable sale fact: a `sales` header + frozen `sale_lines`
 * snapshot, built ALONGSIDE the 005 ingestion seam (reuses tenant-context/RLS;
 * the Idempotency-Key interceptor is engaged by the controller decorator).
 *
 * Invariants enforced here:
 *   - POS total preserved VERBATIM (FR-030); the SaaS computes a per-line
 *     half-up comparison total for an ADVISORY `mismatch_flag` only — it never
 *     rewrites the POS total.
 *   - No-float money (gate A.6): amounts stay strings end-to-end; the
 *     comparison sum is computed by Postgres `numeric`, never JS number.
 *   - `mismatch_flag` is set at capture (advisory, SaaS-owned). `processed_at`
 *     is left NULL — the off-request worker (FR-071) claims unprocessed rows
 *     via the `idx_sales_unprocessed` partial index.
 *   - Dedup on `(tenant_id, source_system, external_id)` (FR-050): a
 *     re-delivery (same provenance, possibly a different Idempotency-Key)
 *     returns the SAME sale reference deterministically (FR-100), no
 *     double-apply. Cross-tenant externalId collisions are isolated (SI-001) —
 *     the dedup key includes tenant_id and RLS scopes every read/write.
 *   - Line snapshot is frozen (FR-003): `tenant_product_ref` is lineage only;
 *     a line with no resolvable product is still snapshotted and NO tenant
 *     product is auto-created (FR-004).
 *   - Provenance: `source_system` / `external_id` / SHA-256-canonical
 *     `payload_hash` retained for reconciliation (gate C).
 *
 * Every DB call runs inside `runWithTenantContext` so 003/008 RLS policies
 * apply to the app connection. The outbox producer is injected OPTIONALLY so
 * the capture integration spec can construct the service with PG_POOL only
 * (mirrors UnknownItemsService's optional enqueuer).
 */
import { createHash } from "node:crypto";

import { Inject, Injectable, Optional } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";
import type { Pool } from "pg";

import { PG_POOL } from "../../auth/auth.module";
import type { CaptureSaleRequestDto } from "./dto/capture-sale-request.dto";

/** Optional outbox producer seam (kept optional for PG_POOL-only test wiring). */
export interface SalesOutboxProducer {
  enqueue(event: {
    tenantId: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}
export const SALES_OUTBOX_PRODUCER = Symbol("SALES_OUTBOX_PRODUCER");

export interface CaptureSaleInput {
  readonly tenantId: string;
  readonly storeId: string;
  readonly actorUserId: string;
  readonly body: CaptureSaleRequestDto;
}

/** The `toBody` wire projection of a captured sale (snake-free, no secrets). */
export interface SaleProjection {
  readonly saleRef: string;
  readonly storeId: string;
  readonly currencyCode: string;
  readonly posTotal: string;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly businessDate: string;
  readonly processedAt: string | null;
  readonly sourceClockAt: string | null;
  readonly sourceSystem: string;
  readonly externalId: string;
  readonly mismatchFlag: boolean;
  readonly lines: ReadonlyArray<SaleLineProjection>;
}

export interface SaleLineProjection {
  readonly lineName: string;
  readonly unitPrice: string;
  readonly currencyCode: string;
  readonly quantity: string;
  readonly lineAmount: string;
  readonly taxAmount: string | null;
  readonly unit: string;
  readonly tenantProductRef: string | null;
}

export interface CaptureSaleResult {
  readonly projection: SaleProjection;
  /** false when a re-delivery resolved to an existing row (no INSERT). */
  readonly created: boolean;
}

interface SaleRow {
  id: string;
  store_id: string;
  currency_code: string;
  pos_total: string;
  occurred_at: Date;
  received_at: Date;
  business_date: string;
  processed_at: Date | null;
  source_clock_at: Date | null;
  source_system: string;
  external_id: string;
  mismatch_flag: boolean | null;
}

interface SaleLineRow {
  line_name: string;
  unit_price: string;
  currency_code: string;
  quantity: string;
  line_amount: string;
  tax_amount: string | null;
  unit: string;
  tenant_product_ref: string | null;
}

/**
 * SHA-256 over a canonical (sorted-key) JSON serialization of a value
 * (gate C). Deterministic key ordering so US5/T062 provenance-reconcile can
 * reproduce the hash from the stored payload. No float involved — the input
 * is the request DTO whose money fields are strings.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
  );
  return `{${entries.join(",")}}`;
}

function sha256CanonicalHex(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

@Injectable()
export class SalesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Optional()
    @Inject(SALES_OUTBOX_PRODUCER)
    private readonly outbox?: SalesOutboxProducer,
  ) {}

  async captureSale(input: CaptureSaleInput): Promise<CaptureSaleResult> {
    const { tenantId, storeId, actorUserId, body } = input;
    const payloadHash = sha256CanonicalHex(body);

    const result = await runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client): Promise<{ saleId: string; created: boolean }> => {
        // Dedup-first (FR-050): a re-delivery with the same provenance resolves
        // to the existing row deterministically. The dedup key is scoped by
        // tenant_id, so a cross-tenant externalId collision is isolated.
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM sales
            WHERE tenant_id = $1 AND source_system = $2 AND external_id = $3
            LIMIT 1`,
          [tenantId, body.sourceSystem, body.externalId],
        );
        if (existing.rows[0]) {
          return { saleId: existing.rows[0].id, created: false };
        }

        // Advisory comparison total (gate A.3/A.4): half-up sum of per-line
        // amounts, computed by Postgres numeric — NEVER JS float. mismatch_flag
        // is TRUE when it differs from the POS-reported total. The POS total is
        // stored verbatim regardless (FR-030).
        const compare = await client.query<{ mismatch: boolean }>(
          `SELECT (round(SUM(amt)::numeric, 4) <> $1::numeric) AS mismatch
             FROM unnest($2::numeric[]) AS amt`,
          [body.posTotal, body.lines.map((l) => l.lineAmount)],
        );
        const mismatchFlag = compare.rows[0]?.mismatch ?? false;

        // UUIDv7 (time-ordered) via the shared id policy — fact tables are
        // high-write, so v7 B-tree locality matters; matches reconciliation.
        const saleId = newId();
        // business_date is derived from the store timezone in a later slice
        // (FR-023 / US2); for capture we record the occurredAt calendar date in
        // UTC. processed_at is intentionally NULL — the worker claims it.
        await client.query(
          `INSERT INTO sales
             (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
              business_date, source_system, external_id, payload_hash,
              mismatch_flag, created_by)
           VALUES ($1, $2, $3, $4, $5::numeric, $6::timestamptz,
                   ($6::timestamptz AT TIME ZONE 'UTC')::date, $7, $8, $9,
                   $10, $11)`,
          [
            saleId,
            tenantId,
            storeId,
            body.currencyCode,
            body.posTotal,
            body.occurredAt,
            body.sourceSystem,
            body.externalId,
            payloadHash,
            mismatchFlag,
            actorUserId,
          ],
        );

        for (const line of body.lines) {
          await client.query(
            `INSERT INTO sale_lines
               (id, sale_id, tenant_id, store_id, line_name, unit_price,
                currency_code, quantity, line_amount, tax_amount, unit,
                tenant_product_ref)
             VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8::numeric,
                     $9::numeric, $10, $11, $12)`,
            [
              newId(),
              saleId,
              tenantId,
              storeId,
              line.lineName,
              line.unitPrice,
              line.currencyCode,
              line.quantity,
              line.lineAmount,
              line.taxAmount ?? null,
              line.unit,
              line.tenantProductRef ?? null,
            ],
          );
        }

        return { saleId, created: true };
      },
    );

    if (result.created && this.outbox) {
      await this.outbox
        .enqueue({
          tenantId,
          type: "sale.captured",
          payload: { saleId: result.saleId },
        })
        .catch(() => undefined);
    }

    const projection = await this.readSaleProjection(tenantId, result.saleId);
    return { projection, created: result.created };
  }

  /** Read a sale + its lines and build the `toBody` projection. */
  async readSaleProjection(
    tenantId: string,
    saleId: string,
  ): Promise<SaleProjection> {
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client): Promise<SaleProjection> => {
        const sale = await client.query<SaleRow>(
          `SELECT id, store_id, currency_code, pos_total, occurred_at,
                  received_at, business_date, processed_at, source_clock_at,
                  source_system, external_id, mismatch_flag
             FROM sales WHERE id = $1`,
          [saleId],
        );
        const row = sale.rows[0];
        if (!row) {
          // Object-level authz / non-disclosing: a sale outside the caller's
          // scope is filtered by RLS and reads as absent.
          throw new SaleNotFoundError();
        }
        const lines = await client.query<SaleLineRow>(
          `SELECT line_name, unit_price, currency_code, quantity, line_amount,
                  tax_amount, unit, tenant_product_ref
             FROM sale_lines WHERE sale_id = $1 ORDER BY line_name`,
          [saleId],
        );
        return toBody(row, lines.rows);
      },
    );
  }
}

/** Thrown when a sale ref does not resolve within the caller's scope. */
export class SaleNotFoundError extends Error {
  constructor() {
    super("sale not found");
    this.name = "SaleNotFoundError";
  }
}

function toBody(row: SaleRow, lines: ReadonlyArray<SaleLineRow>): SaleProjection {
  return {
    saleRef: row.id,
    storeId: row.store_id,
    currencyCode: row.currency_code,
    posTotal: row.pos_total,
    occurredAt: row.occurred_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
    businessDate:
      typeof row.business_date === "string"
        ? row.business_date
        : new Date(row.business_date).toISOString().slice(0, 10),
    processedAt: row.processed_at ? row.processed_at.toISOString() : null,
    sourceClockAt: row.source_clock_at ? row.source_clock_at.toISOString() : null,
    sourceSystem: row.source_system,
    externalId: row.external_id,
    mismatchFlag: row.mismatch_flag ?? false,
    lines: lines.map((l) => ({
      lineName: l.line_name,
      unitPrice: l.unit_price,
      currencyCode: l.currency_code,
      quantity: l.quantity,
      lineAmount: l.line_amount,
      taxAmount: l.tax_amount,
      unit: l.unit,
      tenantProductRef: l.tenant_product_ref,
    })),
  };
}
