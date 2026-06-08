/**
 * apps/api/test/catalog/erpnext-product-reconciliation/schema/erpnext-product-reconciliation-schema-shape.spec.ts
 *
 * Slice 021-SCHEMA (T004a) — Drizzle schema-shape test for the
 * erpnext_product_reconciliation_* table family (run + result + repair_attempt).
 *
 * The Docker-FREE companion to the Testcontainers migration round-trip in
 * `packages/db/__tests__/migration/0023-erpnext-product-reconciliation.spec.ts`.
 * Introspects the Drizzle table objects exported from `@data-pulse-2/db/schema`
 * and asserts the 021 data-model.md §2 column inventory + the load-bearing
 * NEGATIVES (no money/valuation/PII — BUSINESS-class operational records; no
 * `kind` column; no `store_id` — a mapping is tenant-wide).
 */
import "reflect-metadata";

import { getTableConfig } from "drizzle-orm/pg-core";

import {
  erpnextProductReconciliationRun,
  erpnextProductReconciliationResult,
  erpnextProductReconciliationRepairAttempt,
} from "@data-pulse-2/db/schema";

type ColumnInfo = { name: string; notNull: boolean; columnType: string; hasDefault: boolean };

function columns(table: unknown): Map<string, ColumnInfo> {
  const cfg = getTableConfig(table as Parameters<typeof getTableConfig>[0]);
  const out = new Map<string, ColumnInfo>();
  for (const col of cfg.columns) {
    const c = col as unknown as ColumnInfo;
    out.set(c.name, {
      name: c.name,
      notNull: c.notNull,
      columnType: c.columnType,
      hasDefault: c.hasDefault,
    });
  }
  return out;
}

const MONEY_PII = [
  "amount", "pos_total", "line_amount", "unit_price", "total", "money",
  "valuation", "cost", "price", "on_hand", "stock_value",
  "email", "password_hash", "token_hash",
];

describe("product-reconciliation schema shape — run", () => {
  const cols = columns(erpnextProductReconciliationRun);
  it("carries the §2.1 run column inventory", () => {
    for (const n of [
      "id", "tenant_id", "trigger", "status", "erpnext_view_status",
      "started_at", "finished_at", "summary", "actor_user_id",
      "correlation_id", "created_at", "updated_at",
    ]) {
      expect(cols.has(n)).toBe(true);
    }
  });
  it("is TENANT-scoped (NO store_id) and has NO kind column", () => {
    expect(cols.has("store_id")).toBe(false);
    expect(cols.has("kind")).toBe(false);
  });
  it("tenant_id NOT NULL; status + erpnext_view_status default; finished_at nullable", () => {
    expect(cols.get("tenant_id")?.notNull).toBe(true);
    expect(cols.get("status")?.hasDefault).toBe(true);
    expect(cols.get("erpnext_view_status")?.hasDefault).toBe(true);
    expect(cols.get("finished_at")?.notNull).toBe(false);
  });
  it("carries NO money/valuation/PII column", () => {
    for (const f of MONEY_PII) expect(cols.has(f)).toBe(false);
  });
});

describe("product-reconciliation schema shape — result", () => {
  const cols = columns(erpnextProductReconciliationResult);
  it("carries the §2.2 result column inventory", () => {
    for (const n of [
      "id", "run_id", "tenant_id", "mismatch_class", "tenant_product_id",
      "erpnext_item_ref", "source_system", "external_id", "result_state",
      "detail", "created_at", "updated_at",
    ]) {
      expect(cols.has(n)).toBe(true);
    }
  });
  it("run_id + tenant_id + mismatch_class NOT NULL; refs nullable (polymorphic line)", () => {
    expect(cols.get("run_id")?.notNull).toBe(true);
    expect(cols.get("tenant_id")?.notNull).toBe(true);
    expect(cols.get("mismatch_class")?.notNull).toBe(true);
    expect(cols.get("tenant_product_id")?.notNull).toBe(false);
    expect(cols.get("erpnext_item_ref")?.notNull).toBe(false);
  });
  it("result_state defaults (open)", () => {
    expect(cols.get("result_state")?.hasDefault).toBe(true);
  });
  it("carries NO money/valuation/PII column", () => {
    for (const f of MONEY_PII) expect(cols.has(f)).toBe(false);
  });
});

describe("product-reconciliation schema shape — repair_attempt (append-only)", () => {
  const cols = columns(erpnextProductReconciliationRepairAttempt);
  it("carries the §2.3 repair-attempt column inventory", () => {
    for (const n of [
      "id", "tenant_id", "target_kind", "target_ref_id", "repair_kind",
      "actor_user_id", "outcome", "resolved_item_map_id", "expected_version",
      "correlation_id", "created_at",
    ]) {
      expect(cols.has(n)).toBe(true);
    }
  });
  it("is APPEND-ONLY: NO updated_at column", () => {
    expect(cols.has("updated_at")).toBe(false);
  });
  it("target_kind + target_ref_id + repair_kind + actor + outcome NOT NULL", () => {
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
