/**
 * `audit_events` — immutable governance/security log. (data-model.md §12)
 *
 * INSERT-only at the application layer. UPDATEs are not granted to the app
 * role in `drizzle/0000_initial.sql`. Indexed for compliance exports and
 * action-prefix queries (FR-AUDIT-2).
 *
 * RLS-enabled by `tenant_id`. Rows with `tenant_id IS NULL` are platform-
 * scoped and visible only to platform admins.
 */
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { stores } from "./stores";
import { tenants } from "./tenants";
import { users } from "./users";

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").primaryKey(),
  occurredAt: timestamp("occurred_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  actorUserId: uuid("actor_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  actorLabel: text("actor_label"),
  tenantId: uuid("tenant_id").references(() => tenants.id, {
    onDelete: "restrict",
  }),
  storeId: uuid("store_id").references(() => stores.id, {
    onDelete: "set null",
  }),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: uuid("target_id"),
  metadata: jsonb("metadata").notNull().default({}),
  requestId: uuid("request_id"),
  /**
   * T311 — lifecycle marker set by the retention sweep worker.
   * NULL = row has not yet been evaluated by the sweep.
   * Non-null = sweep marked this row as past the documented retention window
   * (365 days from occurred_at). No audit fact columns are altered by the sweep.
   * Only the retention worker path may set this column.
   */
  retentionMarkedAt: timestamp("retention_marked_at", { withTimezone: true }),
});

export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEventRow = typeof auditEvents.$inferInsert;
