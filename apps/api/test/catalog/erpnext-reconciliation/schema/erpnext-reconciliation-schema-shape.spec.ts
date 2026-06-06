/**
 * apps/api/test/catalog/erpnext-reconciliation/schema/erpnext-reconciliation-schema-shape.spec.ts
 *
 * Slice 017-SCHEMA (T012a) — Drizzle schema-shape test for the
 * erpnext_reconciliation_* table family (run + result + repair_attempt).
 *
 * The lightweight, Docker-FREE companion to the Testcontainers migration
 * round-trip in `packages/db/__tests__/migration/0020-erpnext-reconciliation.spec.ts`.
 * It introspects the Drizzle table objects exported from `@data-pulse-2/db/schema`
 * and asserts the 017 data-model.md §2 column inventory + the load-bearing
 * NEGATIVES (no money/valuation/PII — these are BUSINESS-class operational records).
 *
 * RED-before-GREEN: authored before the schema exists, this file fails to import
 * (the table objects not yet exported) — the intended T012a RED. Once the schema
 * + barrel re-export land + the db package is built, the import resolves.
 */
import "reflect-metadata";

import { getTableConfig } from "drizzle-orm/pg-core";

import {
  erpnextReconciliationRun,
  erpnextReconciliationResult,
  erpnextReconciliationRepairAttempt,
} from "@data-pulse-2/db/schema";

type ColumnInfo = { name: string; notNull: boolean; columnType: string; hasDefault: boolean };

function columns(table: unknown): Map<string, ColumnInfo> {
  const cfg = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
  const out = new Map<string, ColumnInfo>();
  for (const col of cfg.columns) {
    const c = col as unknown as ColumnInfo;
    out.set(c.name, { name: c.name, notNull: c.notNull, columnType: c.columnType, hasDefault: c.hasDefault });
  }
  return out;
}

const MONEY_PII = [
  "amount", "pos_total", "line_amount", "unit_price", "total", "money",
  "valuation", "cost", "price", "email", "password_hash", "token_hash",
];

describe("reconciliation schema shape — erpnext_reconciliation_run", () => {
  const cols = columns(erpnextReconciliationRun);
  it("carries the §2.1 run column inventory", () => {
    for (const n of [
      "id", "tenant_id", "store_id", "kind", "trigger", "status",
      "started_at", "finished_at", "summary", "actor_user_id",
      "correlation_id", "created_at", "updated_at",
    ]) {
      expect(cols.has(n)).toBe(true);
    }
  });
  it("tenant_id + store_id are NOT NULL (a stock run is store-scoped)", () => {
    expect(cols.get("tenant_id")?.notNull).toBe(true);
    expect(cols.get("store_id")?.notNull).toBe(true);
  });
  it("kind + status default; finished_at is nullable", () => {
    expect(cols.get("kind")?.hasDefault).toBe(true);
    expect(cols.get("status")?.hasDefault).toBe(true);
    expect(cols.get("finished_at")?.notNull).toBe(false);
  });
  it("carries NO money/valuation/PII column", () => {
    for (const f of MONEY_PII) expect(cols.has(f)).toBe(false);
  });
});

describe("reconciliation schema shape — erpnext_reconciliation_result", () => {
  const cols = columns(erpnextReconciliationResult);
  it("carries the §2.2 result column inventory", () => {
    for (const n of [
      "id", "run_id", "tenant_id", "mismatch_class", "source_ref_id",
      "source_system", "external_id", "result_state", "detail",
      "created_at", "updated_at",
    ]) {
      expect(cols.has(n)).toBe(true);
    }
  });
  it("run_id + tenant_id + mismatch_class are NOT NULL; source_ref_id is nullable (polymorphic, aggregate-tolerant)", () => {
    expect(cols.get("run_id")?.notNull).toBe(true);
    expect(cols.get("tenant_id")?.notNull).toBe(true);
    expect(cols.get("mismatch_class")?.notNull).toBe(true);
    expect(cols.get("source_ref_id")?.notNull).toBe(false);
  });
  it("result_state defaults to open", () => {
    expect(cols.get("result_state")?.hasDefault).toBe(true);
  });
  it("carries NO money/valuation/PII column", () => {
    for (const f of MONEY_PII) expect(cols.has(f)).toBe(false);
  });
});

describe("reconciliation schema shape — erpnext_reconciliation_repair_attempt", () => {
  const cols = columns(erpnextReconciliationRepairAttempt);
  it("carries the §2.3 repair-attempt column inventory", () => {
    for (const n of [
      "id", "tenant_id", "target_kind", "target_ref_id", "repair_kind",
      "actor_user_id", "outcome", "resolved_document_ref", "correlation_id",
      "created_at",
    ]) {
      expect(cols.has(n)).toBe(true);
    }
  });
  it("is append-only: no updated_at column (immutable history)", () => {
    expect(cols.has("updated_at")).toBe(false);
  });
  it("target_kind + target_ref_id + repair_kind + actor + outcome are NOT NULL", () => {
    expect(cols.get("target_kind")?.notNull).toBe(true);
    expect(cols.get("target_ref_id")?.notNull).toBe(true);
    expect(cols.get("repair_kind")?.notNull).toBe(true);
    expect(cols.get("actor_user_id")?.notNull).toBe(true);
    expect(cols.get("outcome")?.notNull).toBe(true);
  });
  it("carries NO money/valuation/PII column", () => {
    for (const f of MONEY_PII) expect(cols.has(f)).toBe(false);
  });
});
