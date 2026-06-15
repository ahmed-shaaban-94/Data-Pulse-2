/**
 * `reconciliation_result` — 035 §5 (FR-014). The matched/variance outcome of a
 * remittance vs a claim. `variance` = claimed − remitted (recorded, never
 * hidden; may be negative). outcome = settled | partial | flagged. Append-only.
 * Rejection of a claim line routes to DP-026 reuse (FR-015, NG-1) — not a state
 * here. Composite FK to claim. RLS + FORCE, SELECT/INSERT only; policies in SQL.
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

export const reconciliationResult = pgTable(
  "reconciliation_result",
  {
    id: uuid("id").primaryKey().notNull().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id").notNull(),
    claimedAmount: numeric("claimed_amount", {
      precision: 19,
      scale: 4,
    }).notNull(),
    remittedAmount: numeric("remitted_amount", {
      precision: 19,
      scale: 4,
    }).notNull(),
    variance: numeric("variance", { precision: 19, scale: 4 }).notNull(),
    outcome: text("outcome").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "reconciliation_result_outcome_valid",
      sql`${t.outcome} IN ('settled', 'partial', 'flagged')`,
    ),
    index("idx_reconciliation_result_claim").on(
      t.tenantId,
      t.claimId,
      t.id.desc(),
    ),
    foreignKey({
      name: "fk_reconciliation_result_claim",
      columns: [t.claimId, t.tenantId, t.storeId],
      foreignColumns: [claim.id, claim.tenantId, claim.storeId],
    }).onDelete("restrict"),
  ],
);

export type ReconciliationResultRow = typeof reconciliationResult.$inferSelect;
export type NewReconciliationResultRow =
  typeof reconciliationResult.$inferInsert;
