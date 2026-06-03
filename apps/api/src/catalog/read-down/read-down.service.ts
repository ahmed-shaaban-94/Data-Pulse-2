/**
 * ReadDownService — 010 US1-SNAPSHOT (T035).
 *
 * Implements `posGetCatalogSnapshot` from
 * `packages/contracts/openapi/catalog/read-down.yaml`:
 *   GET /api/pos/v1/catalog/snapshot → the Resolved Sellable Store Catalogue
 *   (Tenant Catalog ⊕ Store Override, 003 §6.4) for the device principal's
 *   (tenant_id, store_id), at a server-issued opaque cursor, cursor-paginated.
 *
 * READ-ONLY. The platform stays the catalogue authority (§IX); there is no
 * write surface. The advisory-op DELTA derivation is US2's job — NOT here.
 *
 * Resolver (built fresh — no prior Tenant ⊕ Override read service existed):
 * LEFT JOIN store_product_overrides on (tenant_id, store_id, product_id) and
 * COALESCE each overrideable field (price, currency, is_active, tax_category)
 * over the tenant base. Sellable filter (R5): resolved active AND not retired
 * AND price present AND currency present AND representable in the currency's
 * minor unit. Excluded rows emit the unpriced-issue signal + are absent from
 * the page.
 *
 * Cursor (FR-011): the opaque snapshot cursor IS the change-log head sequence
 * (research R1) — `SELECT max(sequence) FROM catalog_change_log` under the
 * tenant GUC. Encoded opaque (base64) so the mechanism stays invisible. All
 * pages of one snapshot reflect the SAME cursor point (FR-012).
 *
 * Scope comes from the device principal ONLY (never the body) — the controller
 * passes the resolved (tenant_id, store_id); the service runs every query under
 * `runWithTenantContext` so RLS enforces tenant isolation, and an explicit
 * store_id predicate enforces the store boundary.
 */
import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";

import { PG_POOL } from "../../auth/auth.module";
import { runWithTenantContext } from "@data-pulse-2/db";
import { recordCatalogUnpricedIssue } from "../../observability/metrics/api.metrics";
import {
  encodeCursor,
  decodeCursor,
  ReadDownCursorError,
  type SnapshotCursor,
} from "./read-down.cursor";
import {
  toSellableRow,
  isRepresentable,
  type ResolvedCatalogRow,
  type SellableCatalogRow,
} from "./read-down.toBody";

/** One page of the resolved sellable catalogue (contract CatalogSnapshotPage). */
export interface CatalogSnapshotPage {
  readonly items: ReadonlyArray<SellableCatalogRow>;
  /** The snapshot's opaque server cursor (same across every page — FR-012). */
  readonly cursor: string;
  /** Opaque next-page token; null on the last page. */
  readonly next_page_token: string | null;
}

/** Default + max page size (contract Limit: 1..1000, default 500). */
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 1000;

interface ResolvedRow {
  product_id: string;
  sku: string | null;
  aliases: string[] | null;
  name: string;
  resolved_price: string | null;
  resolved_currency: string | null;
  resolved_tax_category: string;
  resolved_active: boolean;
  retired_at: Date | null;
  row_sequence: string | null;
}

@Injectable()
export class ReadDownService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Resolve + page the sellable catalogue snapshot for (tenantId, storeId).
   *
   * `pageToken` (opaque) continues a prior page within the SAME cursor point;
   * `cursorToken` (opaque) pins the snapshot to a consistent change-log head so
   * concurrent mutations after it are not torn into pages (FR-012). The first
   * call (no cursorToken) reads the current head and uses it for all pages.
   */
  async getSnapshot(
    tenantId: string,
    storeId: string,
    opts: {
      limit?: number | undefined;
      pageToken?: string | null | undefined;
      cursorToken?: string | null | undefined;
    } = {},
  ): Promise<CatalogSnapshotPage> {
    const limit = clampLimit(opts.limit);

    return runWithTenantContext(
      this.pool,
      { tenantId, isPlatformAdmin: false },
      async (client): Promise<CatalogSnapshotPage> => {
        // Establish the STORE context: store_product_overrides is RLS'd by
        // tenant_id AND store_id (0008/0009/0011), so without app.current_store
        // the override rows are RLS-hidden and the LEFT JOIN silently yields
        // NULL (falling through to the tenant price). transaction-local
        // (is_local = true) so it does not leak across pool reuse. Mirrors
        // StoreOverrideService — the legitimate way to read store-scoped rows
        // under the device principal's resolved store (NOT a SECURITY-DEFINER /
        // platform-admin bypass, which would break §II store isolation).
        await client.query("SELECT set_config('app.current_store', $1, true)", [
          storeId,
        ]);

        // Pin the snapshot cursor: reuse the caller's pinned head if continuing
        // a page set, else read the current change-log head sequence (FR-011).
        let head: SnapshotCursor;
        if (opts.cursorToken) {
          head = decodeCursor(opts.cursorToken, tenantId, storeId);
        } else {
          const r = await client.query<{ head: string | null }>(
            `SELECT max(sequence)::text AS head FROM catalog_change_log
               WHERE tenant_id = $1`,
            [tenantId],
          );
          head = { tenantId, storeId, sequence: r.rows[0]?.head ?? "0" };
        }
        const cursor = encodeCursor(head);

        // Page boundary: products are ordered by product_id; page_token carries
        // the last product_id emitted at this cursor point.
        const afterProductId = opts.pageToken
          ? decodePageToken(opts.pageToken, tenantId, storeId)
          : null;

        // Resolved(store) = Tenant ⊕ Store Override (003 §6.4). LEFT JOIN the
        // active (non-retired) override for this store and COALESCE each
        // overrideable field. sku + aliases resolve from product_aliases.
        // Over-fetch by 1 to detect a next page.
        const resolved = await client.query<ResolvedRow>(
          `
          SELECT
            tp.id AS product_id,
            tp.name AS name,
            COALESCE(spo.price, tp.default_price)::text AS resolved_price,
            COALESCE(spo.currency_code, tp.default_currency_code) AS resolved_currency,
            COALESCE(spo.tax_category, tp.tax_category) AS resolved_tax_category,
            COALESCE(spo.is_active, tp.is_active) AS resolved_active,
            tp.retired_at AS retired_at,
            (
              SELECT pa.value FROM product_aliases pa
              WHERE pa.tenant_id = tp.tenant_id AND pa.product_id = tp.id
                AND pa.identifier_type = 'sku' AND pa.retired_at IS NULL
                AND (pa.store_id IS NULL OR pa.store_id = $2)
              ORDER BY pa.store_id NULLS LAST LIMIT 1
            ) AS sku,
            (
              SELECT array_agg(pa.value ORDER BY pa.value) FROM product_aliases pa
              WHERE pa.tenant_id = tp.tenant_id AND pa.product_id = tp.id
                AND pa.identifier_type <> 'sku' AND pa.retired_at IS NULL
                AND (pa.store_id IS NULL OR pa.store_id = $2)
            ) AS aliases,
            (
              SELECT max(ccl.sequence)::text FROM catalog_change_log ccl
              WHERE ccl.tenant_id = tp.tenant_id AND ccl.product_id = tp.id
                AND (ccl.store_id = $2 OR ccl.store_id IS NULL)
                AND ccl.sequence <= $3::bigint
            ) AS row_sequence
          FROM tenant_products tp
          LEFT JOIN store_product_overrides spo
            ON spo.tenant_id = tp.tenant_id
           AND spo.store_id = $2
           AND spo.product_id = tp.id
           AND spo.retired_at IS NULL
          WHERE tp.tenant_id = $1
            AND ($4::uuid IS NULL OR tp.id > $4::uuid)
          ORDER BY tp.id
          LIMIT $5
          `,
          [tenantId, storeId, head.sequence, afterProductId, limit + 1],
        );

        const items: SellableCatalogRow[] = [];
        let emitted = 0;
        let lastProductId: string | null = null;
        for (const row of resolved.rows) {
          if (emitted >= limit) break; // the +1 over-fetch row signals next page
          const sellable = this.classifySellable(row);
          if (sellable.kind === "excluded") {
            // R5/R6 — absent from the stream + recorded as an unpriced issue.
            // (NEVER on the sellable stream, NEVER to a cashier — FR-043/044.)
            if (sellable.priceRelated) recordCatalogUnpricedIssue();
            continue;
          }
          items.push(toSellableRow(sellable.row, cursor));
          lastProductId = row.product_id;
          emitted += 1;
        }

        // A next page exists iff the over-fetch returned more than we emitted
        // AND there is a remaining row beyond the last emitted product.
        const hasMore = resolved.rows.length > emitted && lastProductId !== null
          ? resolved.rows.some((r) => r.product_id > (lastProductId as string))
          : resolved.rows.length > limit;
        const next_page_token =
          hasMore && lastProductId
            ? encodePageToken({ tenantId, storeId, afterProductId: lastProductId })
            : null;

        return { items, cursor, next_page_token };
      },
    );
  }

  /**
   * Classify a resolved row as sellable or excluded (R5). Excluded rows carry
   * a `priceRelated` flag so the caller only counts price/currency/representable
   * issues toward the unpriced-issue signal (a retired/inactive row is excluded
   * but is not an "unpriced issue").
   */
  private classifySellable(
    row: ResolvedRow,
  ):
    | { kind: "sellable"; row: ResolvedCatalogRow }
    | { kind: "excluded"; priceRelated: boolean } {
    const active = row.resolved_active && row.retired_at === null;
    const priced = row.resolved_price !== null && row.resolved_currency !== null;
    if (!priced) {
      // null_price / missing_currency (the latter is unreachable as stored data,
      // but guarded defensively). Price-related only if the row was otherwise
      // active (an inactive unpriced row is excluded for activity, not price).
      return { kind: "excluded", priceRelated: active };
    }
    if (!isRepresentable(row.resolved_price as string, row.resolved_currency as string)) {
      return { kind: "excluded", priceRelated: true }; // non_representable
    }
    if (!active) {
      return { kind: "excluded", priceRelated: false }; // retired / deactivated
    }
    return {
      kind: "sellable",
      row: {
        product_id: row.product_id,
        sku: row.sku ?? row.product_id,
        name: row.name,
        aliases: row.aliases ?? [],
        amount: row.resolved_price as string,
        currency_code: row.resolved_currency as string,
        tax_category: row.resolved_tax_category,
        row_sequence: row.row_sequence,
      },
    };
  }
}

function clampLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

// ---------------------------------------------------------------------------
// Page token — opaque, scope-bound (distinct from the snapshot cursor)
// ---------------------------------------------------------------------------

interface PageTokenPayload {
  tenantId: string;
  storeId: string;
  afterProductId: string;
}

function encodePageToken(p: PageTokenPayload): string {
  return Buffer.from(
    JSON.stringify({ t: p.tenantId, s: p.storeId, a: p.afterProductId }),
    "utf8",
  ).toString("base64url");
}

function decodePageToken(
  token: string,
  tenantId: string,
  storeId: string,
): string {
  let payload: { t?: string; s?: string; a?: string };
  try {
    payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new ReadDownCursorError("malformed page_token");
  }
  if (payload.t !== tenantId || payload.s !== storeId || !payload.a) {
    // Scope-bound: a page token from another scope is non-disclosingly rejected.
    throw new ReadDownCursorError("page_token scope mismatch");
  }
  return payload.a;
}
