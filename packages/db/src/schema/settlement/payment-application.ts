/**
 * `payment_application` — 035 §5 (FR-011/12). DP-2-owned cash application (7-C),
 * append-only ledger; child of `receivable` (the contract apply-payment is
 * per-receivable). The receivable's `outstanding_balance` is the running
 * aggregate. Idempotency is enforced by the request IdempotencyInterceptor
 * (no per-row idempotency column). `note` is redacted in audit (§XIII/XIV).
 * RLS + FORCE, SELECT/INSERT only (append-only); policies in the SQL.
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
import { receivable } from "./receivable";

export const paymentApplication = pgTable(
  "payment_application",
  {
    id: uuid("id").primaryKey().notNull().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    // FK is composite (receivable_id, tenant_id, store_id) — declared below.
    receivableId: uuid("receivable_id").notNull(),
    appliedAmount: numeric("applied_amount", {
      precision: 19,
      scale: 4,
    }).notNull(),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("payment_application_amount_positive", sql`${t.appliedAmount} > 0`),
    index("idx_payment_application_receivable").on(
      t.tenantId,
      t.receivableId,
      t.id.desc(),
    ),
    foreignKey({
      name: "fk_payment_application_receivable",
      columns: [t.receivableId, t.tenantId, t.storeId],
      foreignColumns: [receivable.id, receivable.tenantId, receivable.storeId],
    }).onDelete("restrict"),
  ],
);

export type PaymentApplicationRow = typeof paymentApplication.$inferSelect;
export type NewPaymentApplicationRow = typeof paymentApplication.$inferInsert;
