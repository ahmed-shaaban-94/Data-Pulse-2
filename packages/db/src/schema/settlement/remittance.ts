/**
 * `remittance` — 035 §5 (FR-014). Amounts paid by a third-party payer against a
 * claim. Append-only; `remittance_ref` is an opaque payer-side advice ref.
 * Composite FK to claim within the same tenant/store. RLS + FORCE, SELECT/INSERT
 * only; policies in the SQL.
 */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { stores } from "../stores";
import { tenants } from "../tenants";
import { claim } from "./claim";

export const remittance = pgTable(
  "remittance",
  {
    id: uuid("id").primaryKey().notNull().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id").notNull(),
    remittedAmount: numeric("remitted_amount", {
      precision: 19,
      scale: 4,
    }).notNull(),
    remittanceRef: text("remittance_ref"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("remittance_amount_non_negative", sql`${t.remittedAmount} >= 0`),
    index("idx_remittance_claim").on(t.tenantId, t.claimId, t.id.desc()),
    foreignKey({
      name: "fk_remittance_claim",
      columns: [t.claimId, t.tenantId, t.storeId],
      foreignColumns: [claim.id, claim.tenantId, claim.storeId],
    }).onDelete("restrict"),
  ],
);

export type RemittanceRow = typeof remittance.$inferSelect;
export type NewRemittanceRow = typeof remittance.$inferInsert;
