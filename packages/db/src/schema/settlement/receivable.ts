/**
 * `receivable` — 035 §5 (FR-005/6/7). Money owed against a sale by a payer.
 *
 * CARVE (035-DR-SETTLEMENT §OQ-4): state = open|partially_applied|settled|
 * claimed|flagged. NO `reversal_consumed` — reversal-compat is a later additive
 * migration after DP-026 closes.
 * 7-C (§OQ-7): `erpnextPaymentEntryRef` is a NULLABLE pointer to the ERPNext
 * accounting Payment Entry (valuation projection ERPNext owns); DP-2 owns the
 * operational record. NULL until the connector posting gate (011-DR-POSTING-R1).
 * `taxPlaceholder` is tax-pending only (no VAT allocation, §OQ-2).
 *
 * Composite FK (sale_id, tenant_id, store_id) -> sales: a receivable can never
 * attach to a sale in another tenant/store (0012/0026 child-table precedent).
 * The sale fact is NEVER mutated (FR-006). RLS + FORCE; policies in the SQL.
 */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { stores } from "../stores";
import { tenants } from "../tenants";
import { sales } from "../sales/sales";
import { payerAccount } from "./payer-account";

export const receivable = pgTable(
  "receivable",
  {
    id: uuid("id").primaryKey().notNull().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    // FK is composite (sale_id, tenant_id, store_id) — declared below.
    saleId: uuid("sale_id").notNull(),
    payerId: uuid("payer_id")
      .notNull()
      .references(() => payerAccount.id, { onDelete: "restrict" }),
    outstandingBalance: numeric("outstanding_balance", {
      precision: 19,
      scale: 4,
    }).notNull(),
    state: text("state").notNull().default("open"),
    erpnextPaymentEntryRef: text("erpnext_payment_entry_ref"),
    taxPlaceholder: jsonb("tax_placeholder"),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "receivable_state_valid",
      sql`${t.state} IN ('open', 'partially_applied', 'settled', 'claimed', 'flagged')`,
    ),
    check("receivable_balance_non_negative", sql`${t.outstandingBalance} >= 0`),
    check("receivable_version_non_negative", sql`${t.version} >= 0`),
    // Composite-FK target key for child tables (payment_application,
    // claim_receivables) — mirrors uq_receivable_id_tenant_store in the SQL.
    unique("uq_receivable_id_tenant_store").on(t.id, t.tenantId, t.storeId),
    index("idx_receivable_tenant_store_list").on(
      t.tenantId,
      t.storeId,
      t.id.desc(),
    ),
    index("idx_receivable_payer").on(t.tenantId, t.payerId),
    index("idx_receivable_open")
      .on(t.tenantId, t.storeId, t.id.desc())
      .where(sql`${t.state} IN ('open', 'partially_applied', 'claimed')`),
    foreignKey({
      name: "fk_receivable_sale_tenant_store",
      columns: [t.saleId, t.tenantId, t.storeId],
      foreignColumns: [sales.id, sales.tenantId, sales.storeId],
    }).onDelete("restrict"),
  ],
);

export type ReceivableRow = typeof receivable.$inferSelect;
export type NewReceivableRow = typeof receivable.$inferInsert;
