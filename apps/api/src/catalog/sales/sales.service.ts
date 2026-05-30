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
import type { RecordVoidRequestDto } from "./dto/record-void-request.dto";
import type { RecordRefundRequestDto } from "./dto/record-refund-request.dto";

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

export interface RecordVoidInput {
  readonly tenantId: string;
  readonly storeId: string;
  readonly actorUserId: string;
  readonly saleRef: string;
  readonly body: RecordVoidRequestDto;
}

export interface RecordRefundInput {
  readonly tenantId: string;
  readonly storeId: string;
  readonly actorUserId: string;
  readonly saleRef: string;
  readonly body: RecordRefundRequestDto;
}

/** Wire projection of a void/refund terminal event (contract `SaleTerminalEvent`). */
export interface TerminalEventProjection {
  readonly eventRef: string;
  readonly saleRef: string;
  readonly kind: "void" | "refund";
  readonly recordedAt: string;
  /** Present (non-null) only for refunds. */
  readonly posRefundAmount: string | null;
  /** Present (non-null) only for refunds. */
  readonly currencyCode: string | null;
}

export interface TerminalEventResult {
  readonly projection: TerminalEventProjection;
  /** false when a re-delivery resolved to an existing terminal event. */
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
        // Dedup (FR-050) is enforced atomically by the INSERT ... ON CONFLICT
        // below — a single race-safe path, no read-before-write window. A
        // re-delivery with the same provenance resolves deterministically to
        // the existing row (FR-100). The dedup key is scoped by tenant_id, so a
        // cross-tenant externalId collision is isolated (SI-001).

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

        // business_date is the occurredAt CALENDAR DATE in the STORE's timezone
        // (FR-023) — never the client clock. Resolve the store's IANA zone under
        // tenant RLS; the principal's own store always resolves (the sales FK
        // guarantees the store exists), so a miss is a misconfigured principal —
        // fail loudly, never silently default to UTC. (Stores default to 'UTC'
        // until an operator sets a real zone, so this reproduces the prior UTC
        // behavior until then.) processed_at stays NULL — the worker claims it.
        const tz = await client.query<{ timezone: string }>(
          `SELECT timezone FROM stores WHERE id = $1`,
          [storeId],
        );
        const storeTimezone = tz.rows[0]?.timezone;
        if (!storeTimezone) {
          throw new Error("store timezone not resolvable for capture");
        }
        //
        // Atomic dedup (FR-050/100): ON CONFLICT on the
        // (tenant_id, source_system, external_id) unique index makes the write
        // race-safe — a concurrent or re-delivered identical capture does NOT
        // double-insert or surface a 500; it falls through to the deterministic
        // resolve below (zero rows returned ⇒ the row already exists).
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO sales
             (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
              business_date, source_clock_at, source_system, external_id,
              payload_hash, mismatch_flag, created_by)
           VALUES ($1, $2, $3, $4, $5::numeric, $6::timestamptz,
                   ($6::timestamptz AT TIME ZONE $13)::date, $7::timestamptz,
                   $8, $9, $10, $11, $12)
           ON CONFLICT (tenant_id, source_system, external_id) DO NOTHING
           RETURNING id`,
          [
            saleId,
            tenantId,
            storeId,
            body.currencyCode,
            body.posTotal,
            body.occurredAt,
            body.sourceClockAt ?? null,
            body.sourceSystem,
            body.externalId,
            payloadHash,
            mismatchFlag,
            actorUserId,
            storeTimezone,
          ],
        );

        if (inserted.rows.length === 0) {
          // The provenance already exists — a prior re-delivery or a concurrent
          // racing capture won. Resolve to that row deterministically (replay,
          // no double-apply). No line inserts: the winner already wrote them.
          const winner = await client.query<{ id: string }>(
            `SELECT id FROM sales
              WHERE tenant_id = $1 AND source_system = $2 AND external_id = $3
              LIMIT 1`,
            [tenantId, body.sourceSystem, body.externalId],
          );
          const winnerId = winner.rows[0]?.id;
          if (!winnerId) {
            throw new Error("dedup conflict but no existing sale row found");
          }
          return { saleId: winnerId, created: false };
        }

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

    const projection = await this.readSaleProjection(
      tenantId,
      storeId,
      result.saleId,
    );
    return { projection, created: result.created };
  }

  /**
   * Read a sale + its lines and build the `toBody` projection.
   *
   * Scoped by tenant AND store (spec §120/§449, FR-063): RLS enforces the
   * tenant boundary, but the `sales_tenant_read` policy is tenant-only, so the
   * store boundary is enforced here with an explicit `store_id` predicate. A
   * sale outside the caller's store reads as absent (non-disclosing 404).
   */
  async readSaleProjection(
    tenantId: string,
    storeId: string,
    saleId: string,
  ): Promise<SaleProjection> {
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client): Promise<SaleProjection> => {
        const sale = await client.query<SaleRow>(
          // business_date::text returns the exact calendar date as a string. A
          // bare `date` column is parsed by node-pg into a JS Date at LOCAL
          // midnight, and `.toISOString()` then shifts it by the process tz —
          // corrupting the store-local date (FR-023). Casting to text avoids it.
          `SELECT id, store_id, currency_code, pos_total, occurred_at,
                  received_at, business_date::text AS business_date,
                  processed_at, source_clock_at,
                  source_system, external_id, mismatch_flag
             FROM sales WHERE id = $1 AND store_id = $2`,
          [saleId, storeId],
        );
        const row = sale.rows[0];
        if (!row) {
          // Object-level authz / non-disclosing: a sale outside the caller's
          // tenant (RLS) or store (predicate above) reads as absent.
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

  /**
   * Record a void terminal event (US3 / T053).
   *
   * A void is a SEPARATE append-only record — the original `sales` row and its
   * `sale_lines` are NEVER mutated (§X); "voided" is derived from the presence
   * of this event. Object-safety (FR-014, SI-004): the target sale must resolve
   * within the caller's (tenant via RLS, store via predicate) scope, else a
   * non-disclosing `SaleNotFoundError` (→ 404) and NO record is written.
   *
   * Idempotent on the void's OWN `(tenant_id, source_system, external_id)`
   * provenance (FR-013): a re-delivery is a deterministic replay (no duplicate),
   * via the same atomic `ON CONFLICT` pattern as capture. `voided_at` is the DB
   * `now()` server clock — never client-supplied.
   */
  async recordVoid(input: RecordVoidInput): Promise<TerminalEventResult> {
    const { tenantId, storeId, actorUserId, saleRef, body } = input;
    const payloadHash = sha256CanonicalHex(body);
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client): Promise<TerminalEventResult> => {
        // Object-safety gate: the sale must exist within (tenant, store) scope
        // BEFORE any terminal-event write. A wrong-store/unknown ref is a
        // non-disclosing 404 — no void row, no existence leak.
        const sale = await client.query<{ id: string }>(
          `SELECT id FROM sales WHERE id = $1 AND store_id = $2`,
          [saleRef, storeId],
        );
        if (!sale.rows[0]) {
          throw new SaleNotFoundError();
        }

        const eventId = newId();
        const inserted = await client.query<{ id: string; voided_at: Date }>(
          `INSERT INTO sale_voids
             (id, sale_id, tenant_id, store_id, source_system, external_id,
              payload_hash, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (tenant_id, source_system, external_id) DO NOTHING
           RETURNING id, voided_at`,
          [
            eventId,
            saleRef,
            tenantId,
            storeId,
            body.sourceSystem,
            body.externalId,
            payloadHash,
            actorUserId,
          ],
        );

        if (inserted.rows.length === 0) {
          // The void provenance already exists. It is a deterministic REPLAY
          // only if it points at the SAME sale (FR-013). The unique index is
          // (tenant, source_system, external_id) — NOT scoped by sale — so the
          // existing row may belong to a different sale; we must read its
          // sale_id and never echo the caller's saleRef.
          const existing = await client.query<{
            id: string;
            sale_id: string;
            voided_at: Date;
          }>(
            `SELECT id, sale_id, voided_at FROM sale_voids
              WHERE tenant_id = $1 AND source_system = $2 AND external_id = $3
              LIMIT 1`,
            [tenantId, body.sourceSystem, body.externalId],
          );
          const row = existing.rows[0];
          if (!row) {
            throw new Error("void conflict but no existing terminal event found");
          }
          if (row.sale_id !== saleRef) {
            // Same provenance reused for a DIFFERENT sale — not a valid replay.
            // Reject as a conflict; never disclose the other sale (FR-013/014).
            throw new TerminalEventProvenanceConflictError();
          }
          return {
            projection: toTerminalEvent("void", row.id, row.sale_id, row.voided_at, null, null),
            created: false,
          };
        }

        const row = inserted.rows[0]!;
        return {
          projection: toTerminalEvent("void", row.id, saleRef, row.voided_at, null, null),
          created: true,
        };
      },
    );
  }

  /**
   * Record a refund terminal event (US4 / T058).
   *
   * Same shape + invariants as `recordVoid` — a SEPARATE append-only
   * `sale_refunds` record, never mutating the sale (§X); object-safety
   * non-disclosing 404 (FR-014); idempotent on the refund's own provenance with
   * the cross-sale-collision guard (FR-013). Additionally preserves the
   * POS-reported refund amount VERBATIM (FR-012/030) — the SaaS stores it as-is
   * and never rewrites it. `refunded_at` is the DB server clock.
   */
  async recordRefund(input: RecordRefundInput): Promise<TerminalEventResult> {
    const { tenantId, storeId, actorUserId, saleRef, body } = input;
    const payloadHash = sha256CanonicalHex(body);
    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client): Promise<TerminalEventResult> => {
        const sale = await client.query<{ id: string }>(
          `SELECT id FROM sales WHERE id = $1 AND store_id = $2`,
          [saleRef, storeId],
        );
        if (!sale.rows[0]) {
          throw new SaleNotFoundError();
        }

        const eventId = newId();
        const inserted = await client.query<{
          id: string;
          refunded_at: Date;
          pos_refund_amount: string;
          currency_code: string;
        }>(
          `INSERT INTO sale_refunds
             (id, sale_id, tenant_id, store_id, pos_refund_amount, currency_code,
              source_system, external_id, payload_hash, created_by)
           VALUES ($1, $2, $3, $4, $5::numeric, $6, $7, $8, $9, $10)
           ON CONFLICT (tenant_id, source_system, external_id) DO NOTHING
           RETURNING id, refunded_at, pos_refund_amount, currency_code`,
          [
            eventId,
            saleRef,
            tenantId,
            storeId,
            body.posRefundAmount,
            body.currencyCode,
            body.sourceSystem,
            body.externalId,
            payloadHash,
            actorUserId,
          ],
        );

        if (inserted.rows.length === 0) {
          // Provenance already exists — a replay only if it points at the SAME
          // sale (FR-013); otherwise a conflict (never echo the caller's ref).
          const existing = await client.query<{
            id: string;
            sale_id: string;
            refunded_at: Date;
            pos_refund_amount: string;
            currency_code: string;
          }>(
            `SELECT id, sale_id, refunded_at, pos_refund_amount, currency_code
               FROM sale_refunds
              WHERE tenant_id = $1 AND source_system = $2 AND external_id = $3
              LIMIT 1`,
            [tenantId, body.sourceSystem, body.externalId],
          );
          const row = existing.rows[0];
          if (!row) {
            throw new Error("refund conflict but no existing terminal event found");
          }
          if (row.sale_id !== saleRef) {
            throw new TerminalEventProvenanceConflictError();
          }
          return {
            projection: toTerminalEvent(
              "refund",
              row.id,
              row.sale_id,
              row.refunded_at,
              row.pos_refund_amount,
              row.currency_code,
            ),
            created: false,
          };
        }

        const row = inserted.rows[0]!;
        return {
          projection: toTerminalEvent(
            "refund",
            row.id,
            saleRef,
            row.refunded_at,
            row.pos_refund_amount,
            row.currency_code,
          ),
          created: true,
        };
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

/**
 * Thrown when a terminal-event provenance `(tenant, source_system, external_id)`
 * is reused for a DIFFERENT sale than the one it was first recorded against —
 * a client conflict (→ 409), not a valid idempotent replay (FR-013).
 */
export class TerminalEventProvenanceConflictError extends Error {
  constructor() {
    super("terminal event provenance already used for a different sale");
    this.name = "TerminalEventProvenanceConflictError";
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

/** Build the `SaleTerminalEvent` wire projection for a void/refund event. */
function toTerminalEvent(
  kind: "void" | "refund",
  eventRef: string,
  saleRef: string,
  recordedAt: Date,
  posRefundAmount: string | null,
  currencyCode: string | null,
): TerminalEventProjection {
  return {
    eventRef,
    saleRef,
    kind,
    recordedAt: recordedAt.toISOString(),
    posRefundAmount,
    currencyCode,
  };
}
