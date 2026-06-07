/**
 * apps/api/test/connector/schema/connector-registration-schema-shape.spec.ts
 *
 * Slice 018-SCHEMA — Drizzle schema-shape test for connector_registration + the
 * additive auth_tokens.connector_registration_id link.
 *
 * The lightweight, Docker-FREE companion to the Testcontainers migration
 * round-trip in
 * `packages/db/__tests__/migration/0021-connector-registration.spec.ts`. It
 * introspects the Drizzle table objects exported from `@data-pulse-2/db/schema`
 * and asserts the 018 data-model.md column inventory + the load-bearing
 * NEGATIVES (no money/PII/secret — BUSINESS-class only, §XIV).
 */
import "reflect-metadata";

import { getTableConfig } from "drizzle-orm/pg-core";

import { authTokens, connectorRegistration } from "@data-pulse-2/db/schema";

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

const MONEY_PII_SECRET = [
  "amount", "pos_total", "line_amount", "unit_price", "total", "money",
  "valuation", "cost", "price", "email", "password_hash", "token_hash",
  "secret", "token", "api_key", "credential",
];

describe("connector schema shape — connector_registration (Entity 1)", () => {
  const cols = columns(connectorRegistration);

  it("carries the data-model.md Entity 1 column inventory", () => {
    for (const n of [
      "id", "tenant_id", "display_name", "erpnext_site_ref", "environment",
      "created_at", "created_by", "disabled_at", "disabled_by",
    ]) {
      expect(cols.has(n)).toBe(true);
    }
  });

  it("tenant_id / display_name / erpnext_site_ref / environment / created_by are NOT NULL", () => {
    expect(cols.get("tenant_id")?.notNull).toBe(true);
    expect(cols.get("display_name")?.notNull).toBe(true);
    expect(cols.get("erpnext_site_ref")?.notNull).toBe(true);
    expect(cols.get("environment")?.notNull).toBe(true);
    expect(cols.get("created_by")?.notNull).toBe(true);
  });

  it("disabled_at / disabled_by are nullable (logical disable, FR-014)", () => {
    expect(cols.get("disabled_at")?.notNull).toBe(false);
    expect(cols.get("disabled_by")?.notNull).toBe(false);
  });

  it("created_at defaults (now())", () => {
    expect(cols.get("created_at")?.hasDefault).toBe(true);
  });

  it("carries NO money/PII/secret column", () => {
    for (const f of MONEY_PII_SECRET) expect(cols.has(f)).toBe(false);
  });
});

describe("connector schema shape — auth_tokens link (Entity 2)", () => {
  const cols = columns(authTokens);

  it("gains the nullable connector_registration_id link column", () => {
    expect(cols.has("connector_registration_id")).toBe(true);
    expect(cols.get("connector_registration_id")?.notNull).toBe(false);
  });

  it("still carries token_hash (the existing hashed-secret path — never the raw secret)", () => {
    expect(cols.has("token_hash")).toBe(true);
  });
});
