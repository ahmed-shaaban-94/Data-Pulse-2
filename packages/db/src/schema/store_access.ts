/**
 * `store_access` — explicit allowed-store list when a membership uses the
 * `'specific'` access kind. (data-model.md §5)
 *
 * Invariant I-3 (StoreAccess and parent Membership share a tenant) is
 * enforced via composite FKs declared in `drizzle/0000_initial.sql`:
 *   - `(tenant_id, membership_id) → memberships(tenant_id, id)`
 *   - `(tenant_id, store_id)      → stores(tenant_id, id)`
 *
 * Drizzle's TS-level FKs reference single columns only (`memberships.id`,
 * `stores.id`); the actual integrity invariant is enforced by the SQL
 * composite FKs.
 *
 * RLS-enabled by `tenant_id`.
 */
import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { memberships } from "./memberships";
import { stores } from "./stores";
import { tenants } from "./tenants";

export const storeAccess = pgTable(
  "store_access",
  {
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.membershipId, t.storeId] }),
  }),
);

export type StoreAccessRow = typeof storeAccess.$inferSelect;
export type NewStoreAccessRow = typeof storeAccess.$inferInsert;
