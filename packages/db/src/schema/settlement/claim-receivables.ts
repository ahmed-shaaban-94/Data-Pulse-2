/**
 * `claim_receivables` — 035 §5 (FR-014). The claim ↔ receivable join (the
 * contract `ClaimCreate.receivableRefs[]` is many). A receivable appears at most
 * once per claim (unique). Both composite FKs stay within the same tenant/store.
 * RLS + FORCE, SELECT/INSERT only (append-only join); policies in the SQL.
 */
import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { stores } from "../stores";
import { tenants } from "../tenants";
import { claim } from "./claim";
import { receivable } from "./receivable";

export const claimReceivables = pgTable(
  "claim_receivables",
  {
    id: uuid("id").primaryKey().notNull().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id").notNull(),
    receivableId: uuid("receivable_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("uq_claim_receivables").on(t.claimId, t.receivableId),
    index("idx_claim_receivables_claim").on(t.tenantId, t.claimId),
    index("idx_claim_receivables_receivable").on(t.tenantId, t.receivableId),
    foreignKey({
      name: "fk_claim_receivables_claim",
      columns: [t.claimId, t.tenantId, t.storeId],
      foreignColumns: [claim.id, claim.tenantId, claim.storeId],
    }).onDelete("restrict"),
    foreignKey({
      name: "fk_claim_receivables_receivable",
      columns: [t.receivableId, t.tenantId, t.storeId],
      foreignColumns: [receivable.id, receivable.tenantId, receivable.storeId],
    }).onDelete("restrict"),
  ],
);

export type ClaimReceivableRow = typeof claimReceivables.$inferSelect;
export type NewClaimReceivableRow = typeof claimReceivables.$inferInsert;
