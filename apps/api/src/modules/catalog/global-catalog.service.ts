/**
 * GlobalCatalogService — T361 (GREEN slice paired with T360 RED).
 *
 * Responsibility
 * --------------
 * The ONLY sanctioned read path that exposes the platform-wide
 * `global_products` index to tenant-side actors. Per spec §5.1
 * (`specs/003-catalog-foundation/spec.md`) and data-model.md §2:
 *
 *   - Global Product Index is platform-scoped, NOT tenant-scoped.
 *   - Any authenticated tenant user MAY read the active rows
 *     (RLS SELECT policy on `global_products` is `USING (true)`).
 *   - Platform Admin is the sole writer (separate slice — not here).
 *   - Retired rows (`retired_at IS NOT NULL`) MUST be excluded from
 *     this list view (active-only contract pinned by T360 spec).
 *
 * v1 contract (pinned by T360)
 * ----------------------------
 *   - `list()` takes NO parameters: no pagination, no filters.
 *     Pagination, if needed, is a separate future slice (T362+).
 *   - Returns rows shaped at minimum as
 *     `{ id: string; name: string; retired_at: string | null }`.
 *     We deliberately use SNAKE_CASE for `retired_at` to match the
 *     T360 spec's assertion (`row.retired_at` toBeNull()).
 *
 * RLS interaction
 * ---------------
 * Because `global_products` SELECT policy is unconditional
 * (`USING (true)`), this service does NOT need to open a
 * `runWithTenantContext` transaction of its own. The caller may
 * already be inside one (the T360 spec wraps `service.list()` in
 * `runWithTenantContext(env.admin, { tenantId, isPlatformAdmin:false }, ...)`);
 * we issue our query against the pool, which checks out a fresh
 * connection — RLS still admits the SELECT because the policy is
 * unconditional, and `retired_at IS NULL` performs the active-only
 * filter at the SQL layer.
 *
 * This is intentionally simpler than `StoresService.list`, which
 * requires the tenant GUC to be set on the connection. Global
 * catalog does not.
 */
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Pool } from "pg";

import { PG_POOL } from "../../auth/auth.module";

/**
 * Minimum shape pinned by the T360 RED spec. The DTO is intentionally
 * thin — list-view consumers only need id, name, and the retired_at
 * sentinel to verify the active-only filter. Richer projections
 * (description, suggested_category, default_price, ...) belong to a
 * future detail-view slice, not the list endpoint.
 */
export interface GlobalProductRow {
  id: string;
  name: string;
  retired_at: string | null;
}

@Injectable()
export class GlobalCatalogService {
  /**
   * The pool is accepted as a raw `pg.Pool`. Nest DI decoration
   * (`@Inject(PG_POOL)`) is applied for production wiring via the
   * forthcoming catalog module; the T360 spec instantiates
   * `new GlobalCatalogService(env.admin)` directly with a raw pool,
   * which the `@Optional()` form supports.
   */
  constructor(
    @Optional() @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  /**
   * List all active global_products. Retired rows are filtered at the
   * SQL layer via `retired_at IS NULL`, which also lines up with the
   * partial index `idx_global_products_active` (0007_catalog.sql).
   *
   * Ordering is by `name` then `id` so the list is stable across calls
   * and across tenant contexts (Group C of the T360 spec asserts the
   * same id set from Tenant A and Tenant B — equal-content arrays).
   */
  async list(): Promise<GlobalProductRow[]> {
    const result = await this.pool.query<GlobalProductRow>(
      `SELECT id, name, retired_at
         FROM global_products
        WHERE retired_at IS NULL
        ORDER BY name ASC, id ASC`,
    );
    return result.rows;
  }
}
