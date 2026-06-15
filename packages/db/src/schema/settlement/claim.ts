/**
 * `claim` — 035 §5 (FR-014). A submission of receivable(s) to a third-party
 * payer for collection. Status = submitted | acknowledged | reconciled.
 * Receivables are linked via the `claim_receivables` join. Optimistic
 * concurrency via `version`. RLS + FORCE; policies in the SQL.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { stores } from "../stores";
import { tenants } from "../tenants";
import { payerAccount } from "./payer-account";

export const claim = pgTable(
  "claim",
  {
    id: uuid("id").primaryKey().notNull().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    payerId: uuid("payer_id")
      .notNull()
      .references(() => payerAccount.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("submitted"),
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
      "claim_status_valid",
      sql`${t.status} IN ('submitted', 'acknowledged', 'reconciled')`,
    ),
    check("claim_version_non_negative", sql`${t.version} >= 0`),
    // Composite-FK target key for child tables (claim_receivables, remittance,
    // reconciliation_result) — mirrors uq_claim_id_tenant_store in the SQL.
    unique("uq_claim_id_tenant_store").on(t.id, t.tenantId, t.storeId),
    index("idx_claim_tenant_store_list").on(t.tenantId, t.storeId, t.id.desc()),
  ],
);

export type ClaimRow = typeof claim.$inferSelect;
export type NewClaimRow = typeof claim.$inferInsert;
