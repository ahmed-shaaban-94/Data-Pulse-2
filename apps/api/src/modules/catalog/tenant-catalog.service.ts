/**
 * TenantCatalogService — slice 005 Wave 1 / T351 GREEN implementation.
 *
 * Pairs with the RED contract at
 * `apps/api/test/catalog/tenant-catalog.service.create.spec.ts` (T350).
 *
 * Scope (Wave 1)
 * --------------
 * Only `create` is implemented in this slice. Subsequent waves will add
 * read / update / retire and bind a controller. The service is a raw-Pool
 * service in the style of `apps/api/src/stores/stores.service.ts` —
 * `runWithTenantContext` orchestrates RLS GUCs around each unit of work,
 * and a `TenantTxRunner` indirection seam lets unit tests inject a
 * fake runner without touching production wiring.
 *
 * Constitution / spec anchors
 * ---------------------------
 *   - §II Multi-tenant RLS — every write executes inside
 *     `runWithTenantContext`; cross-tenant reads cannot see this row.
 *   - §III Backend authority / §XII Object safety / spec §5.2 —
 *     the body-supplied `tenantId`, if any, is discarded. The persisted
 *     row's `tenant_id` is always taken from the authenticated principal.
 *     This is the [S1][Q6] non-trust rule from the catalog RLS matrix.
 *   - §VII Audit trail — every successful create writes one
 *     `audit_events` row in the SAME transaction as the
 *     `tenant_products` INSERT. Atomic audit: if either INSERT fails,
 *     both roll back. No async fanout / queue / outbox dependency.
 *
 * Audit dual-emission caveat (future controller wave)
 * ---------------------------------------------------
 * The existing route-level pipeline at
 * `apps/api/src/audit/audit-emitter.interceptor.ts` writes a SECOND
 * audit row from `@Auditable("…")` decorators on HTTP handlers. When a
 * catalog controller is added in a later wave, it MUST NOT also carry
 * `@Auditable("catalog.product.create")`, OR this service must learn an
 * "audit already emitted" skip flag. Otherwise every HTTP create will
 * persist two audit rows for one logical action. Tracked for the
 * controller slice; not addressed here because the RED test instantiates
 * the service directly with no HTTP context.
 */
import {
  Inject,
  Injectable,
  Optional,
} from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { newId } from "@data-pulse-2/shared";
import {
  runWithTenantContext,
  type TenantContext,
} from "@data-pulse-2/db";

import { PG_POOL } from "../../auth/auth.module";

/**
 * Indirection seam reused from `StoresService`. Production calls the real
 * `runWithTenantContext`; unit tests inject a passthrough that fabricates
 * a `PoolClient`-shaped object so the create orchestration can be exercised
 * without a real Postgres pool.
 */
type TenantTxRunner = <T>(
  pool: Pool,
  ctx: TenantContext,
  work: (client: PoolClient) => Promise<T>,
) => Promise<T>;

/** Principal the service authenticates against. */
export interface CatalogPrincipal {
  readonly userId: string;
  readonly tenantId: string;
}

/**
 * Create-product DTO. `tenantId` is INTENTIONALLY accepted in the type so
 * Constitution-§12 violations are typeable and testable; it is ALWAYS
 * discarded by the service in favour of `principal.tenantId`.
 */
export interface CreateTenantProductInput {
  readonly name?: string;
  readonly taxCategory?: string;
  /** Body-supplied tenantId — silently ignored. See class header. */
  readonly tenantId?: string;
}

/** Public record returned by `create`. Camel-cased to match TS conventions. */
export interface TenantProductRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly taxCategory: string;
  readonly retiredAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Raw row shape returned by the `RETURNING` clause. */
interface TenantProductRow {
  id: string;
  tenant_id: string;
  name: string;
  tax_category: string;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
}

const AUDIT_ACTION_CREATE = "catalog.product.create";
const AUDIT_TARGET_TYPE = "tenant_product";

@Injectable()
export class TenantCatalogService {
  private readonly tx: TenantTxRunner;

  constructor(
    @Inject(PG_POOL)
    private readonly pool: Pool,
    /** Optional injected runner for tests. Production callers omit it. */
    @Optional() tx?: TenantTxRunner,
  ) {
    this.tx = tx ?? runWithTenantContext;
  }

  /**
   * Create a new `tenant_products` row owned by the principal's tenant.
   *
   * Validation
   * ----------
   * `name` and `taxCategory` are required non-empty strings (after trim).
   * Missing or empty values throw before any DB work.
   *
   * Atomicity
   * ---------
   * The product INSERT and the audit-event INSERT execute on the same
   * `PoolClient` inside one `runWithTenantContext` transaction. A failure
   * on either rolls both back. Audit and state cannot diverge.
   */
  async create(
    principal: CatalogPrincipal,
    input: CreateTenantProductInput,
  ): Promise<TenantProductRecord> {
    // ---- Validation (pre-DB) ----------------------------------------
    const name = typeof input?.name === "string" ? input.name.trim() : "";
    const taxCategory =
      typeof input?.taxCategory === "string" ? input.taxCategory.trim() : "";

    if (name.length === 0) {
      throw new Error("TenantCatalogService.create: 'name' is required");
    }
    if (taxCategory.length === 0) {
      throw new Error(
        "TenantCatalogService.create: 'taxCategory' is required",
      );
    }

    // ---- Server-resolved tenant_id (Constitution §12 / spec §5.2) ----
    // Body-supplied `tenantId`, if any, is intentionally discarded — the
    // persisted row's tenant_id always comes from the principal.
    const tenantId = principal.tenantId;
    const actorUserId = principal.userId;
    const productId = newId();
    const auditId = newId();

    const ctx: TenantContext = {
      tenantId,
      isPlatformAdmin: false,
    };

    return this.tx(this.pool, ctx, async (client) => {
      // Insert the product row. `created_by` / `updated_by` are NOT NULL
      // on `tenant_products` (no FK) — both default to the actor.
      // RLS WITH CHECK enforces tenant_id matches the GUC we just set.
      const productInsert = await client.query<TenantProductRow>(
        `INSERT INTO tenant_products
           (id, tenant_id, name, tax_category, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $5)
         RETURNING
           id,
           tenant_id,
           name,
           tax_category,
           retired_at,
           created_at,
           updated_at`,
        [productId, tenantId, name, taxCategory, actorUserId],
      );

      const row = productInsert.rows[0];
      if (!row) {
        // Defensive: an INSERT with RETURNING that yields zero rows would
        // indicate either an RLS WITH CHECK rejection (different SQLSTATE
        // path normally) or a driver bug. Surface as a hard error.
        throw new Error(
          "TenantCatalogService.create: INSERT returned no row",
        );
      }

      // Audit event in the SAME transaction. `tenant_id` on audit_events
      // is FK-constrained to tenants(id) and the audit_events RLS policy
      // requires it match `app.current_tenant`, which is already set on
      // this client by `runWithTenantContext`.
      await client.query(
        `INSERT INTO audit_events
           (id, actor_user_id, tenant_id, action, target_type, target_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          auditId,
          actorUserId,
          tenantId,
          AUDIT_ACTION_CREATE,
          AUDIT_TARGET_TYPE,
          row.id,
          "{}",
        ],
      );

      return mapRow(row);
    });
  }
}

function mapRow(row: TenantProductRow): TenantProductRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    taxCategory: row.tax_category,
    retiredAt: row.retired_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
