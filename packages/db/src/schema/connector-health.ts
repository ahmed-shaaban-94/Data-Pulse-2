/**
 * `connector_health` — 020 Connector Health and Connection-Status API
 * (data-model.md Entity 1). The current liveness READ-MODEL for one connector
 * instance: exactly one row per 018 `connector_registration`, created lazily on
 * the first accepted heartbeat. Last-write-wins (no `version` column — monotonic
 * observational data, plan.md Complexity Tracking).
 *
 * Holds NO secret, NO PII, NO money — BUSINESS-class observational telemetry
 * only (§XIV). Identity is REFERENCED by FK to `connector_registration`, never
 * copied; the credential/secret material stays in `auth_tokens` (018).
 *
 * §IX: this is a read-model / observational projection, NOT a source of truth.
 * The identity source of truth is 018 `connector_registration`;
 * ERPNext-reachability is the connector's self-report (provenance), never a
 * DP2-derived probe result (the arc boundary — DP2 makes NO outbound ERPNext HTTP).
 *
 * §X: `last_seen_at` is the DP2 SERVER clock at the last accepted heartbeat —
 * the only field the liveness verdict reads. `source_clock_at` is the
 * connector-reported clock, stored as provenance only and NEVER used for the
 * verdict.
 *
 * Constraints (declared in migration `0022_connector_health.sql`):
 *   - PK `id` (UUIDv7).
 *   - `tenant_id` NOT NULL FK -> tenants(id) ON DELETE RESTRICT (RLS axis).
 *   - `connector_registration_id` NOT NULL FK -> connector_registration(id)
 *     ON DELETE CASCADE, UNIQUE — one health row per registration; the upsert
 *     conflict target for the LWW heartbeat write.
 *   - nullable telemetry: `last_seen_at`, `connector_version` (<=64 chars),
 *     `backlog_indicator` (>=0), `erpnext_reachable`, `source_clock_at`,
 *     `reported_fields_at`.
 *   - NO `version` column (LWW).
 *
 * RLS: ENABLE + FORCE; fail-closed empty-GUC CASE guard; SELECT/INSERT/UPDATE
 * scoped to `app.current_tenant`. NO DELETE policy — a health row disappears
 * only via the registration FK cascade. Mirrors 0019/0020/0021. Policies live
 * in the 0022 migration.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { connectorRegistration } from "./connector_registration";
import { tenants } from "./tenants";

export const connectorHealth = pgTable(
  "connector_health",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    connectorRegistrationId: uuid("connector_registration_id")
      .notNull()
      .references(() => connectorRegistration.id, { onDelete: "cascade" }),
    // Server clock at the last accepted heartbeat; NULL => never_seen. The only
    // field the liveness verdict reads (§X).
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    // Self-reported connector software version.
    connectorVersion: text("connector_version"),
    // Self-reported lag / backlog (e.g. pending postings); non-negative.
    backlogIndicator: integer("backlog_indicator"),
    // Self-reported ERPNext-reachability flag (NOT a DP2 probe result).
    erpnextReachable: boolean("erpnext_reachable"),
    // Connector-reported clock; provenance only, never used for the verdict (§X).
    sourceClockAt: timestamp("source_clock_at", { withTimezone: true }),
    // Server clock when the self-reported fields were last updated.
    reportedFieldsAt: timestamp("reported_fields_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("uq_connector_health_registration").on(t.connectorRegistrationId),
    check(
      "connector_health_version_len",
      sql`${t.connectorVersion} IS NULL OR length(${t.connectorVersion}) <= 64`,
    ),
    check(
      "connector_health_backlog_non_negative",
      sql`${t.backlogIndicator} IS NULL OR ${t.backlogIndicator} >= 0`,
    ),
  ],
);

export type ConnectorHealthRow = typeof connectorHealth.$inferSelect;
export type NewConnectorHealthRow = typeof connectorHealth.$inferInsert;
