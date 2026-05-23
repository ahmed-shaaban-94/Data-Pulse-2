/**
 * ProductAliasesService — T384 GREEN implementation for the T383 RED spec.
 *
 * Sibling test: apps/api/test/catalog/product-aliases.service.spec.ts
 * Spec slice:   003-catalog-foundation Wave (T383/T384)
 * Migration:    packages/db/drizzle/0007_catalog.sql §6 (product_aliases)
 *
 * Role
 * ----
 * Persists rows into `product_aliases` and surfaces the data-model.md §6
 * uniqueness / consistency contract to callers. The database does the
 * uniqueness enforcement via three partial UNIQUE indexes; this service
 * is intentionally thin and lets PG do the heavy lifting:
 *
 *   1. UQ_idx_product_aliases_tenant_wide
 *        ON (tenant_id, identifier_type, value)
 *        WHERE store_id IS NULL
 *          AND identifier_type <> 'external_pos_id'
 *          AND retired_at IS NULL
 *
 *   2. UQ_idx_product_aliases_external_pos_id
 *        ON (tenant_id, source_system, value)
 *        WHERE identifier_type = 'external_pos_id'
 *          AND retired_at IS NULL
 *
 *   3. UQ_idx_product_aliases_store_scoped
 *        ON (tenant_id, store_id, identifier_type, value)
 *        WHERE store_id IS NOT NULL
 *          AND retired_at IS NULL
 *
 * Plus the two CHECK constraints from the migration that the service
 * deliberately does NOT pre-validate (it lets PG reject and surfaces
 * the rejection as a thrown error):
 *
 *   - product_aliases_source_system_required
 *       external_pos_id ↔ source_system IS NOT NULL
 *   - product_aliases_store_scope_consistency
 *       store_id IS NULL OR identifier_type <> 'external_pos_id'
 *
 * Error contract
 * --------------
 * The RED spec's `expectConflictRejection` helper accepts ANY of:
 *   (a) NestJS HttpException with status 409 (ConflictException), or
 *   (b) raw Postgres error with `code === '23505'`, or
 *   (c) generic message matching /duplicate|unique|conflict|already exists/i.
 *
 * We map 23505 (unique_violation) to a NestJS `ConflictException` so the
 * upstream HTTP path returns 409 cleanly. Other Postgres errors (23514
 * check_violation for external_pos_id rules, 23502 not_null_violation,
 * 23503 foreign_key_violation) are re-thrown unchanged — the spec only
 * requires "rejects" for those branches (groups D and H), and rethrowing
 * preserves the SQLSTATE and constraint name for upstream telemetry.
 *
 * Return-shape note (null vs. undefined)
 * --------------------------------------
 * The spec asserts `result.storeId` and `result.sourceSystem` are
 * `toBeNull()` when the caller passed `undefined`. PG returns `null`
 * for absent columns naturally, so we just pass through what PG gives
 * us; we do NOT coerce to `undefined`.
 *
 * Constructor seam
 * ----------------
 * Takes a raw `pg.Pool`. Tests pass `env.admin` (the testcontainer
 * superuser pool — bypasses RLS, which is what the seed flow needs).
 * Production wiring will inject the application pool through a Nest
 * module; that wiring is not part of this slice.
 */
import { ConflictException, Injectable } from "@nestjs/common";
import type { Pool } from "pg";

import { newId } from "@data-pulse-2/shared";

export type AliasIdentifierType =
  | "barcode"
  | "sku"
  | "plu"
  | "supplier_code"
  | "external_pos_id";

export interface CreateProductAliasInput {
  tenantId: string;
  productId: string;
  identifierType: AliasIdentifierType;
  value: string;
  sourceSystem?: string | undefined;
  storeId?: string | undefined;
}

export interface ProductAliasRecord {
  id: string;
  tenantId: string;
  productId: string;
  // Narrow to the discriminated union so downstream callers get
  // exhaustiveness under strict mode (CodeRabbit PR #303).
  identifierType: AliasIdentifierType;
  value: string;
  sourceSystem: string | null;
  storeId: string | null;
}

/**
 * Shape of a row returned by `INSERT … RETURNING` from `product_aliases`.
 * PG returns NULL columns as `null`; absent columns from the SELECT list
 * are simply not present on the object. We pin the type to match the
 * SELECT list below so missing fields are a compile-time error.
 *
 * `identifier_type` is typed as the discriminated union to match the
 * CHECK constraint on the table (`product_aliases_identifier_type_check`).
 * The DB driver returns it as a plain string; we widen at the boundary
 * via a cast in `mapRow` rather than mid-flight.
 */
interface ProductAliasRow {
  id: string;
  tenant_id: string;
  product_id: string;
  identifier_type: AliasIdentifierType;
  value: string;
  source_system: string | null;
  store_id: string | null;
}

@Injectable()
export class ProductAliasesService {
  constructor(private readonly pool: Pool) {}

  /**
   * Insert one `product_aliases` row. The DB validates uniqueness +
   * CHECK constraints; this service maps unique-violations to 409 and
   * re-throws everything else so the SQLSTATE survives.
   *
   * @param input    Alias payload — see `CreateProductAliasInput`.
   * @param actorId  UUID of the actor — written to `created_by` for audit.
   * @returns        The persisted row mapped to `ProductAliasRecord`.
   *                 `storeId` / `sourceSystem` are `null` when the source
   *                 column is NULL (NOT `undefined`).
   */
  async create(
    input: CreateProductAliasInput,
    actorId: string,
  ): Promise<ProductAliasRecord> {
    const id = newId();
    try {
      const { rows } = await this.pool.query<ProductAliasRow>(
        `
        INSERT INTO product_aliases (
          id,
          tenant_id,
          product_id,
          identifier_type,
          value,
          source_system,
          store_id,
          created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING
          id,
          tenant_id,
          product_id,
          identifier_type,
          value,
          source_system,
          store_id
        `,
        [
          id,
          input.tenantId,
          input.productId,
          input.identifierType,
          input.value,
          input.sourceSystem ?? null,
          input.storeId ?? null,
          actorId,
        ],
      );
      const row = rows[0];
      if (!row) {
        // Defensive: a successful INSERT with RETURNING always yields a
        // row. If PG returns zero rows here it's a driver-level bug, not
        // a domain failure — fail loudly rather than fabricate a record.
        throw new Error(
          "product_aliases INSERT returned no row — driver invariant violated",
        );
      }
      return mapRow(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        // 23505 — one of the three partial unique indexes fired. The
        // spec's `expectConflictRejection` matcher accepts both raw
        // 23505 AND HttpException-with-409; we pick 409 here so the
        // surface presented to callers (and to future HTTP wiring) is
        // a clean ConflictException, matching the StoresService pattern.
        throw new ConflictException("Product alias already exists.");
      }
      // CHK / FK / NOT NULL violations (23514 / 23503 / 23502) are
      // surfaced as-is. The spec asserts `rejects.toBeDefined()` for the
      // CHK paths (groups D and H), so re-throwing the PG error — which
      // is a thrown Error — satisfies the assertion AND keeps SQLSTATE
      // for upstream observability.
      throw err;
    }
  }
}

/**
 * Map a snake_case DB row to the camelCase domain shape. PG returns NULL
 * columns as JS `null`, which is exactly the shape the RED spec asserts
 * with `toBeNull()` — we do NOT coerce to `undefined`.
 */
function mapRow(row: ProductAliasRow): ProductAliasRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    productId: row.product_id,
    identifierType: row.identifier_type,
    value: row.value,
    sourceSystem: row.source_system,
    storeId: row.store_id,
  };
}

/**
 * Detect a Postgres unique-constraint violation (SQLSTATE 23505).
 *
 * Mirrors the `StoresService` helper but does NOT pin a specific
 * constraint name — any of the THREE partial unique indexes on
 * `product_aliases` (`UQ_idx_product_aliases_tenant_wide`,
 * `UQ_idx_product_aliases_external_pos_id`,
 * `UQ_idx_product_aliases_store_scoped`) maps to the same
 * "alias already exists" semantics from the caller's perspective.
 *
 * Recurses one level into `.cause` so ORM wrappers (Drizzle/TypeORM)
 * that nest the underlying `pg.DatabaseError` don't defeat the check.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; cause?: unknown };
  // `||` short-circuits and `isUniqueViolation` re-runs the `!err` /
  // `typeof !== "object"` guard, so passing through `e.cause` blindly
  // is safe even when it's `undefined`. This consolidation removes the
  // separate `e.cause && typeof e.cause === "object"` predicate, whose
  // two sub-branches were uncovered (only real PG `23505` flows are
  // exercised by the RED suite — no ORM-wrapped cause path).
  return e.code === "23505" || isUniqueViolation(e.cause);
}
