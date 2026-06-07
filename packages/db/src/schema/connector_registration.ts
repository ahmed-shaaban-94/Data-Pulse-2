/**
 * `connector_registration` — stable, operator-facing identity of one ERPNext
 * connector deployment for one tenant (018 Connector Boundary Hardening,
 * data-model.md Entity 1). Survives credential rotation: rotating the secret
 * swaps the linked `auth_tokens` row, NOT this identity (research R1, Approach A).
 *
 * Holds NO secret, NO PII, NO money — BUSINESS-class only (§XIV). The credential
 * primitives (`token_hash`, `issued_at`, `expires_at`, `revoked_at`) stay in
 * `auth_tokens`, linked by the new nullable `connector_registration_id` FK.
 *
 * Constraints (declared in migration `0021_connector_registration.sql`):
 *   - PK `id` (UUIDv7) — the `connector_id` operators / audits / 019 / 020 / 023 reference.
 *   - `tenant_id` NOT NULL FK → tenants(id) ON DELETE RESTRICT.
 *   - `display_name` NOT NULL, CHECK `length(btrim(display_name)) > 0` (non-empty/trimmed).
 *   - `erpnext_site_ref` NOT NULL — the ERPNext site label/ref (NOT a secret).
 *   - `environment` NOT NULL, CHECK in ('dev','staging','pilot','prod') — the canonical
 *     wire tokens the request DTO accepts and the CHECK enforces.
 *   - `created_by` NOT NULL FK → users(id) ON DELETE RESTRICT (the acting admin).
 *   - `disabled_at` / `disabled_by` NULL — logical disable (FR-014); `disabled_by`
 *     FK → users(id) ON DELETE RESTRICT.
 *   - UNIQUE (tenant_id, environment, erpnext_site_ref) — a tenant cannot register
 *     the same ERPNext site twice in the same environment (FR-005a, clarify Q1).
 *
 * RLS: ENABLE + FORCE; fail-closed empty-GUC CASE guard; SELECT/INSERT/UPDATE
 * scoped to `app.current_tenant`. NO DELETE policy — disable is logical, rows are
 * retained for audit (FR-014). Policies live in the 0021 migration.
 */
import { sql } from "drizzle-orm";
import { check, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { tenants } from "./tenants";
import { users } from "./users";

export const connectorRegistration = pgTable(
  "connector_registration",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    displayName: text("display_name").notNull(),
    erpnextSiteRef: text("erpnext_site_ref").notNull(),
    environment: text("environment").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledBy: uuid("disabled_by").references(() => users.id, {
      onDelete: "restrict",
    }),
  },
  (t) => [
    check(
      "connector_registration_display_name_non_empty",
      sql`length(btrim(${t.displayName})) > 0`,
    ),
    check(
      "connector_registration_environment_valid",
      sql`${t.environment} IN ('dev', 'staging', 'pilot', 'prod')`,
    ),
    unique("uq_connector_registration_tenant_env_site").on(
      t.tenantId,
      t.environment,
      t.erpnextSiteRef,
    ),
  ],
);

export type ConnectorRegistrationRow =
  typeof connectorRegistration.$inferSelect;
export type NewConnectorRegistrationRow =
  typeof connectorRegistration.$inferInsert;
