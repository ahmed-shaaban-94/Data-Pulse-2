/**
 * `erpnext_product_reconciliation_*` — ERPNext Product-Master Reconciliation &
 * Repair state (021 data-model.md §2). Three tables — 021's OWN operational
 * reconciliation state for product/item-MAPPING divergence (the inverse of 017's
 * stock reconciliation; 021 : 013 :: 017 : 014/009).
 *
 * 021 is the arc's product-master reconciliation surface (run → report → repair).
 * It READS (never mirrors) the 013 `erpnext_item_map` mapping, the 003
 * `tenant_products` catalog, the 008 sale facts, and the connector's ERPNext-item
 * view; it OWNS:
 *
 *   1. `erpnext_product_reconciliation_run` — one reconciliation execution (the
 *      US3 two-sided compare against the connector ERPNext-item view).
 *      TENANT-scoped, NOT store-scoped — a product↔Item mapping is tenant-wide (the
 *      013 no-store-axis precedent). NO `kind` column (unlike 017, which reserved
 *      `kind='stock'`): 021 has exactly one run kind, and the US1 backlog is a
 *      LIVE READ-PROJECTION, never a run — a `kind` column would be vacuous.
 *      `erpnext_view_status` records the connector-view availability so an absent
 *      view is a *reported* condition, never a failed run (FR-007 / R3).
 *   2. `erpnext_product_reconciliation_result` — one classified line of a run's
 *      mismatch report, in **021's product-master vocabulary** (data-model §2.2 /
 *      research R4; derived from 013 §7 + OQ-5/OQ-6). `result_state` is 021's OWN
 *      orthogonal workflow status. Single-column `run_id` FK to the run PK (the 017
 *      advisor #1 rationale — id is a UUIDv7 PK + RLS scopes both rows to one
 *      tenant, so a composite FK buys nothing).
 *   3. `erpnext_product_reconciliation_repair_attempt` — APPEND-ONLY audit of every
 *      repair (`confirm` / `suggest_confirm` / `re_point`) — all DRIVE 013's
 *      EXISTING lifecycle (FR-010); 021 owns no new mapping write. `target_ref_id`
 *      is POLYMORPHIC (a `tenant_products.id` for a backlog repair, or a result id
 *      for a run repair) — deliberately NO FK (the 0019/0020 polymorphic precedent).
 *
 * Mutable tenant-owned resources: run (running → completed/failed) + result
 * (open → repaired/accepted) get SELECT+INSERT+UPDATE RLS; repair_attempt is
 * APPEND-ONLY (SELECT+INSERT only). NO DELETE policy anywhere — retention is a
 * status, not a row removal (§XIV). Policies live in the 0023 migration. RLS-
 * enabled + FORCE by `tenant_id`. TENANT-only tables (no store axis).
 *
 * NO money / valuation / PII column — these are BUSINESS-class operational
 * records (refs, provenance, mismatch classes, counts). The `summary` / `detail`
 * jsonb carry counts + operator-facing attribute values + refs ONLY. The
 * audit-of-record write (FR-015) is a separate in-transaction `INSERT INTO
 * audit_events` done by the 021 service/processor — NOT modeled here.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { tenants } from "../tenants";
import { users } from "../users";

export const erpnextProductReconciliationRun = pgTable(
  "erpnext_product_reconciliation_run",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // v1 emits 'on_demand'; 'scheduled' reserved (R7 / 021-SCHEDULED-RUNS).
    trigger: text("trigger").notNull(),
    status: text("status").notNull().default("running"),
    // Records the connector-view availability so an absent view is a *reported*
    // condition, never a failed run (FR-007 / R3).
    erpnextViewStatus: text("erpnext_view_status").notNull().default("unavailable"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    // Counts by mismatch class — BUSINESS-class counts ONLY, never PII/money.
    summary: jsonb("summary"),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    correlationId: uuid("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "erpnext_product_reconciliation_run_trigger_valid",
      sql`${t.trigger} IN ('on_demand', 'scheduled')`,
    ),
    check(
      "erpnext_product_reconciliation_run_status_valid",
      sql`${t.status} IN ('running', 'completed', 'failed')`,
    ),
    check(
      "erpnext_product_reconciliation_run_view_status_valid",
      sql`${t.erpnextViewStatus} IN ('available', 'unavailable', 'partial')`,
    ),
    check(
      "erpnext_product_reconciliation_run_finished_when_terminal",
      sql`(${t.status} = 'running') = (${t.finishedAt} IS NULL)`,
    ),
    index("idx_erpnext_product_reconciliation_run_tenant_time").on(
      t.tenantId,
      t.startedAt.desc(),
    ),
  ],
);

export const erpnextProductReconciliationResult = pgTable(
  "erpnext_product_reconciliation_result",
  {
    id: uuid("id").primaryKey().notNull(),
    // Single-column FK to the run PK (data-model §2.2 / 017 advisor #1).
    runId: uuid("run_id")
      .notNull()
      .references(() => erpnextProductReconciliationRun.id, {
        onDelete: "restrict",
      }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // 021's product-master vocabulary ONLY (data-model §2.2). 021 owns this
    // vocabulary; it does NOT invent a competing one where 013 named the case.
    mismatchClass: text("mismatch_class").notNull(),
    // The DP2 product ref (NULL for an `unmapped_erpnext_item` line). POLYMORPHIC-ish
    // but a real 003 ref — kept FK-less per the 0019/0020 polymorphic precedent.
    tenantProductId: uuid("tenant_product_id"),
    // The ERPNext item reference (NULL for an `unmapped_dp2_product` line). No FK
    // (external, 012 O-6; the 013 erpnext_item_ref no-FK rationale).
    erpnextItemRef: text("erpnext_item_ref"),
    sourceSystem: text("source_system"),
    externalId: text("external_id"),
    // 021's OWN orthogonal workflow status (distinct from the mismatch class).
    resultState: text("result_state").notNull().default("open"),
    // Operator-facing values (DP2 vs ERPNext attributes, drift fields) — values
    // allowed on the row, NEVER in metric labels.
    detail: jsonb("detail"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "erpnext_product_reconciliation_result_class_valid",
      sql`${t.mismatchClass} IN ('match', 'unmapped_dp2_product', 'suggestion_unconfirmed', 'unmapped_erpnext_item', 'attribute_drift', 'sellable_state_divergence')`,
    ),
    check(
      "erpnext_product_reconciliation_result_state_valid",
      sql`${t.resultState} IN ('open', 'repaired', 'accepted')`,
    ),
    index("idx_erpnext_product_reconciliation_result_run").on(
      t.tenantId,
      t.runId,
      t.mismatchClass,
    ),
  ],
);

export const erpnextProductReconciliationRepairAttempt = pgTable(
  "erpnext_product_reconciliation_repair_attempt",
  {
    id: uuid("id").primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    // A repair from the US1 live backlog (target = a tenant_products.id) or from
    // a persisted US3 result (target = a result id).
    targetKind: text("target_kind").notNull(),
    // The tenant_products.id (backlog repair) OR a result id (run repair).
    // POLYMORPHIC — deliberately NO FK (the 0019/0020 precedent).
    targetRefId: uuid("target_ref_id").notNull(),
    // All DRIVE 013's existing lifecycle (FR-010); 021 owns no new mapping write.
    repairKind: text("repair_kind").notNull(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    outcome: text("outcome").notNull(),
    // Echoed when the repair resolves to a confirmed-and-active 013 mapping
    // (the idempotency echo, FR-011).
    resolvedItemMapId: uuid("resolved_item_map_id"),
    // The 013 `version` the confirm was issued against (provenance for a conflict).
    expectedVersion: integer("expected_version"),
    correlationId: uuid("correlation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "erpnext_product_reconciliation_repair_attempt_target_kind_valid",
      sql`${t.targetKind} IN ('backlog_item', 'result')`,
    ),
    check(
      "erpnext_product_reconciliation_repair_attempt_repair_kind_valid",
      sql`${t.repairKind} IN ('confirm', 'suggest_confirm', 're_point')`,
    ),
    check(
      "erpnext_product_reconciliation_repair_attempt_outcome_valid",
      sql`${t.outcome} IN ('mapped', 'still_unmapped', 'no_op_echo', 'conflict')`,
    ),
    index("idx_erpnext_product_reconciliation_repair_attempt_target").on(
      t.tenantId,
      t.targetKind,
      t.targetRefId,
    ),
  ],
);

export type ErpnextProductReconciliationRunRow =
  typeof erpnextProductReconciliationRun.$inferSelect;
export type NewErpnextProductReconciliationRunRow =
  typeof erpnextProductReconciliationRun.$inferInsert;
export type ErpnextProductReconciliationResultRow =
  typeof erpnextProductReconciliationResult.$inferSelect;
export type NewErpnextProductReconciliationResultRow =
  typeof erpnextProductReconciliationResult.$inferInsert;
export type ErpnextProductReconciliationRepairAttemptRow =
  typeof erpnextProductReconciliationRepairAttempt.$inferSelect;
export type NewErpnextProductReconciliationRepairAttemptRow =
  typeof erpnextProductReconciliationRepairAttempt.$inferInsert;
