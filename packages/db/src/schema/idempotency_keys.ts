/**
 * `idempotency_keys` — POS-future seam. (data-model.md §13)
 *
 * Used by no real endpoint in v1; populated when the first idempotent
 * endpoint ships (FR-POS-SEAM-3). The platform exists today so that the
 * future POS slice attaches without a schema change.
 *
 * The PK is a synthetic UUID `id`. Idempotency-scope uniqueness lives in a
 * separate UNIQUE INDEX `(tenant_id, store_id, client_id, key)` declared
 * with PG15+ `NULLS NOT DISTINCT` so a NULL `store_id` still participates
 * in uniqueness. Both live in `drizzle/0000_initial.sql`.
 *
 * RLS-enabled by `tenant_id`.
 */
import {
  customType,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return "bytea";
  },
});

export const idempotencyKeys = pgTable("idempotency_keys", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  storeId: uuid("store_id"),
  clientId: text("client_id").notNull(),
  key: text("key").notNull(),
  requestHash: bytea("request_hash").notNull(),
  responseStatus: integer("response_status").notNull(),
  responseBody: jsonb("response_body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
export type NewIdempotencyKeyRow = typeof idempotencyKeys.$inferInsert;
