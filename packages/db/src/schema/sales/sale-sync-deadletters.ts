/**
 * `sale_sync_deadletters` — 032 §8 dead-letter / NEEDS_REPAIR quarantine.
 *
 * Holds one row per quarantined failed sale-sync, with PROVENANCE INTACT (028)
 * — never a silent drop (Principle V/XIII). It feeds the §9 Console read/repair
 * surface (the NEEDS_REPAIR list + audit timeline) and is resolved by a
 * server-mediated, audited repair op (no sale-fact rewrite, no POS-local
 * override). It NEVER mutates the `sales` fact.
 *
 * Design (data-model.md deferred the storage shape to the slice):
 *   - A SEPARATE table (not a column) so the failure detail + retry accounting
 *     live off the immutable fact; the four-value server status the Console
 *     reads is the `sales.sync_status` column (0025).
 *   - `classification`: the §8 routing — 'retryable' (transient/auth, backoff)
 *     vs 'needs-repair' (non-retryable, operator-mediated).
 *   - `reason_code`: a REDACTED machine label, NEVER a raw upstream error body
 *     (Principle XIII/XIV).
 *   - Composite FK (sale_id, tenant_id, store_id) -> sales(id, tenant_id,
 *     store_id): a deadletter can never attach to a sale in another
 *     tenant/store (the 0012 child-table precedent).
 *   - One OPEN row per sale (unique on (sale_id, resolved_at)) — a sale may
 *     re-fail after a repair; resolved rows are retained for audit.
 *   - RLS-enabled + FORCE, fail-closed by tenant_id. Policies live in
 *     `0026_sale_sync_status.sql`.
 *
 * Server clocks only (Principle X). No money, no line amounts, no PII, no
 * plaintext secret (BUSINESS-class, §XIV).
 */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { stores } from "../stores";
import { tenants } from "../tenants";
import { sales } from "./sales";

export const saleSyncDeadletters = pgTable(
  "sale_sync_deadletters",
  {
    id: uuid("id").primaryKey().notNull().default(sql`gen_random_uuid()`),
    // FK is composite (sale_id, tenant_id, store_id) — declared below.
    saleId: uuid("sale_id").notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "restrict" }),
    // §8 routing: 'retryable' vs 'needs-repair' (enforced by CHECK in 0025).
    classification: text("classification").notNull(),
    // Redacted machine label; NEVER a raw payload / upstream error body.
    reasonCode: text("reason_code").notNull(),
    // Provenance preserved intact (028 / Principle XIII).
    sourceSystem: text("source_system").notNull(),
    externalId: text("external_id").notNull(),
    // Optional end-to-end correlation id (UUID-typed, matches outbox_events).
    correlationId: uuid("correlation_id"),
    // Retry accounting for the retryable class (backoff bookkeeping).
    retryCount: integer("retry_count").notNull().default(0),
    // Server clocks (Principle X) — never client-supplied.
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Set when a server-mediated repair (§9) resolves the item; NULL while open.
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "sale_sync_deadletters_classification_valid",
      sql`${t.classification} IN ('retryable', 'needs-repair')`,
    ),
    check(
      "sale_sync_deadletters_reason_code_non_empty",
      sql`length(btrim(${t.reasonCode})) > 0`,
    ),
    check(
      "sale_sync_deadletters_retry_count_non_negative",
      sql`${t.retryCount} >= 0`,
    ),
    // One OPEN deadletter per sale (resolved rows retained for audit). MUST be
    // a PARTIAL unique index on the open rows — a plain UNIQUE (sale_id,
    // resolved_at) would not enforce it (Postgres NULLs are distinct, so many
    // open rows could coexist). Matches the 0025 SQL partial unique index.
    uniqueIndex("uq_sale_sync_deadletters_open")
      .on(t.saleId)
      .where(sql`${t.resolvedAt} IS NULL`),
    // §9 NEEDS_REPAIR queue read: tenant+store scoped, newest-first (UUIDv7 id
    // keyset), open needs-repair rows only.
    index("idx_sale_sync_deadletters_needs_repair_open")
      .on(t.tenantId, t.storeId, t.id.desc())
      .where(
        sql`${t.classification} = 'needs-repair' AND ${t.resolvedAt} IS NULL`,
      ),
    foreignKey({
      name: "fk_sale_sync_deadletters_sale_tenant_store",
      columns: [t.saleId, t.tenantId, t.storeId],
      foreignColumns: [sales.id, sales.tenantId, sales.storeId],
    }).onDelete("restrict"),
  ],
);

export type SaleSyncDeadletterRow = typeof saleSyncDeadletters.$inferSelect;
export type NewSaleSyncDeadletterRow = typeof saleSyncDeadletters.$inferInsert;
