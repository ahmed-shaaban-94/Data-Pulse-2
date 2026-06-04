/**
 * `erpnext_item_map` — Product-master identity mapping (013 data-model.md §2).
 *
 * Links a DP2 `tenant_products` row to an ERPNext **Item** reference so a
 * future sale posting (015) can resolve each sale line to a real Item
 * (posting decision §1; "fails-to-DLQ if not"). This is a
 * MAPPING/RECONCILIATION layer, NOT a catalog-authority handover (OQ-1, §IX):
 * `tenant_products` stays authoritative for the retail product; ERPNext owns
 * accounting Item identity only.
 *
 * Key invariants (013 data-model.md):
 *   - OQ-2: 1:1 — at most ONE *active* mapping per (tenant_id, tenant_product_id),
 *     enforced by a PARTIAL unique index WHERE retired_at IS NULL (retired rows
 *     accumulate as history; mirrors 003 `WHERE retired_at IS NULL` uniques).
 *   - OQ-7: suggest-then-confirm. `state` is 'suggested' | 'confirmed'. The
 *     CONFIRMED-ONLY invariant (data-model §3): only 'confirmed' rows are
 *     resolvable; a 'suggested' row is inert until a Tenant Admin confirms it.
 *     A CHECK pairs state='confirmed' with confirmed_by/confirmed_at NOT NULL
 *     (and state='suggested' with both NULL) so the posting path can never
 *     resolve an unconfirmed match ("no silent auto-trust").
 *   - §III: `version` is the optimistic-concurrency token (a DELIBERATE,
 *     justified divergence from the 003 catalog tables' last-write-wins —
 *     confirmation is a trust action; the confirm/retire API uses
 *     `... WHERE id = $1 AND version = $2`, incrementing version; a mismatch
 *     is a 409). version >= 1.
 *   - `erpnext_item_ref` is the ERPNext Item reference in DP2 TERMS (e.g. the
 *     Item code/name as text). NO FK — ERPNext is external, reached only via
 *     the connector (012 O-6 version-independence); mirrors the 003
 *     `source_global_product_id` no-FK rationale (never couple DP2 row
 *     lifecycle to an out-of-DP2 catalogue).
 *   - v1 suggest is MANUAL-ONLY (finding AUTO_MATCH_NO_SOURCE): the
 *     suggestion_source enum keeps 'barcode'|'item_code' for the future, but
 *     v1 only writes 'manual' (no ERPNext item-search op exists in 012).
 *   - NO UOM, price, price-list, or store_id column (OQ-3/OQ-4 resolved as
 *     no-column; tenant-wide identity — data-model §1/§6).
 *
 * Mutable tenant-owned resource: SELECT + INSERT + UPDATE RLS policies
 * (suggested -> confirmed -> retired). Re-point is append-only (retire old +
 * insert new), never an in-place identity rewrite. Policy lives in the
 * 0017_erpnext_item_map.sql migration. RLS-enabled by `tenant_id`.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { tenants } from "../tenants";
import { tenantProducts } from "./tenant-products";

export const erpnextItemMap = pgTable(
  "erpnext_item_map",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    tenantProductId: uuid("tenant_product_id")
      .notNull()
      .references(() => tenantProducts.id, { onDelete: "restrict" }),
    // ERPNext Item reference in DP2 terms. NO FK — external, version-independent.
    erpnextItemRef: text("erpnext_item_ref").notNull(),
    state: text("state").notNull().default("suggested"),
    suggestionSource: text("suggestion_source").notNull(),
    suggestedBy: uuid("suggested_by"),
    suggestedAt: timestamp("suggested_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    confirmedBy: uuid("confirmed_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    // §III optimistic-concurrency token.
    version: integer("version").notNull().default(1),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    correlationId: uuid("correlation_id"),
  },
  (t) => [
    check(
      "erpnext_item_map_state_valid",
      sql`${t.state} IN ('suggested', 'confirmed')`,
    ),
    check(
      "erpnext_item_map_suggestion_source_valid",
      sql`${t.suggestionSource} IN ('barcode', 'item_code', 'manual')`,
    ),
    check(
      "erpnext_item_map_item_ref_length",
      sql`length(${t.erpnextItemRef}) BETWEEN 1 AND 140`,
    ),
    // The confirmed-only invariant (data-model §3): confirmed <=> provenance present.
    check(
      "erpnext_item_map_confirmed_paired",
      sql`(${t.state} = 'confirmed' AND ${t.confirmedBy} IS NOT NULL AND ${t.confirmedAt} IS NOT NULL) OR (${t.state} = 'suggested' AND ${t.confirmedBy} IS NULL AND ${t.confirmedAt} IS NULL)`,
    ),
    check("erpnext_item_map_version_positive", sql`${t.version} >= 1`),
    // OQ-2 1:1 — at most one ACTIVE mapping per (tenant, product).
    uniqueIndex("UQ_idx_erpnext_item_map_active")
      .on(t.tenantId, t.tenantProductId)
      .where(sql`${t.retiredAt} IS NULL`),
    // Tenant-Admin review queue: suggestions awaiting confirmation.
    index("idx_erpnext_item_map_unconfirmed")
      .on(t.tenantId, t.state)
      .where(sql`${t.state} = 'suggested' AND ${t.retiredAt} IS NULL`),
    // Reverse lookup — which product(s) point at an ERPNext Item (reconciliation).
    index("idx_erpnext_item_map_item_ref")
      .on(t.tenantId, t.erpnextItemRef)
      .where(sql`${t.retiredAt} IS NULL`),
  ],
);

export type ErpnextItemMapRow = typeof erpnextItemMap.$inferSelect;
export type NewErpnextItemMapRow = typeof erpnextItemMap.$inferInsert;
