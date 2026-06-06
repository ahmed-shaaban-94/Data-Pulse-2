/**
 * apps/api/test/catalog/erpnext-reconciliation/contract/reconciliation.contract.spec.ts
 *
 * Slice 017-CONTRACT (T010) — OpenAPI conformance test for
 * `packages/contracts/openapi/erpnext-reconciliation/reconciliation.yaml`.
 *
 * Mirrors `apps/api/test/catalog/erpnext-warehouse-map/contract/erpnext-warehouse-map.contract.spec.ts`:
 *   - loads the new contract via the production `loadOpenApiContracts` helper with
 *     an explicit `dir` (the helper's scan is non-recursive — the new top-level
 *     `erpnext-reconciliation/` directory is loaded explicitly);
 *   - asserts the SIX 017 operationIds are present + UNIQUE against every shipped
 *     operationId (top-level + catalog/ + pos-sales/ + erpnext-connector/);
 *   - pins the slice's load-bearing conventions:
 *       · the HUMAN dashboard `cookieAuth` scheme — NOT `connectorBearer` (012
 *         machine) and NOT `clerkJwt` (POS device) (FR-018, the slice stop);
 *       · strict request DTOs (§XII) — no body-supplied tenant/actor/server fields;
 *       · `Idempotency-Key` required on the three mutating ops (O-3, no new primitive);
 *       · the closed Error set incl. `idempotency_key_conflict` (409) + non-disclosing 404;
 *       · the toBody projections — `ReconciliationResult.mismatchClass` is 014's
 *         vocabulary ONLY (no 015 posting categories — READ-NOT-MIRROR); `kind` is
 *         stock-only; NO money/valuation field anywhere.
 *
 * Structural / load-only (no app boot, no HTTP).
 */
import "reflect-metadata";

import { resolve } from "node:path";

import { loadOpenApiContracts } from "../../../../src/openapi/loader";

const NEW_CONTRACT_ID = "reconciliation";
const NEW_SUBDIR = "erpnext-reconciliation";

const OPERATION_IDS = [
  "listPostingBacklog",
  "repairPosting",
  "triggerReconciliationRun",
  "getReconciliationRun",
  "listReconciliationResults",
  "repairStockMismatch",
] as const;

const MUTATING_IDEMPOTENT_OPS = [
  "repairPosting",
  "triggerReconciliationRun",
  "repairStockMismatch",
] as const;

function openapiSubDir(sub: string): string {
  return resolve(
    __dirname, "..", "..", "..", "..", "..", "..",
    "packages", "contracts", "openapi", sub,
  );
}

interface OperationObject {
  operationId?: string;
  parameters?: Array<{ $ref?: string; name?: string; in?: string; required?: boolean }>;
  requestBody?: { content?: Record<string, { schema?: { $ref?: string } }> };
  responses?: Record<string, unknown>;
}
type PathItem = Record<string, OperationObject>;
interface SchemaObject {
  type?: string | string[];
  additionalProperties?: boolean | Record<string, unknown>;
  required?: string[];
  properties?: Record<string, { enum?: string[] }>;
}
interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    securitySchemes?: Record<string, Record<string, unknown>>;
    parameters?: Record<string, { name?: string; in?: string; required?: boolean }>;
  };
  security?: Array<Record<string, unknown>>;
}

let doc: OpenApiDocument;
let shippedOperationIds: Set<string>;

function collectOperationIds(docs: OpenApiDocument[], into: Set<string>): void {
  for (const d of docs) {
    if (!d.paths) continue;
    for (const path of Object.values(d.paths)) {
      for (const op of Object.values(path)) {
        if (op && typeof op.operationId === "string") into.add(op.operationId);
      }
    }
  }
}

beforeAll(() => {
  const contracts = loadOpenApiContracts({ dir: openapiSubDir(NEW_SUBDIR) });
  const newContract = contracts.find((c) => c.id === NEW_CONTRACT_ID);
  if (!newContract) {
    const ids = contracts.map((c) => c.id).join(", ");
    throw new Error(
      `${NEW_CONTRACT_ID} contract not found under ${openapiSubDir(NEW_SUBDIR)}; loaded ids: [${ids}]`,
    );
  }
  doc = newContract.document as OpenApiDocument;

  shippedOperationIds = new Set<string>();
  collectOperationIds(
    loadOpenApiContracts().map((c) => c.document as OpenApiDocument),
    shippedOperationIds,
  );
  for (const sub of ["catalog", "pos-sales", "erpnext-connector"]) {
    collectOperationIds(
      loadOpenApiContracts({ dir: openapiSubDir(sub) }).map((c) => c.document as OpenApiDocument),
      shippedOperationIds,
    );
  }
});

function operations(): Array<{ path: string; method: string; op: OperationObject }> {
  const out: Array<{ path: string; method: string; op: OperationObject }> = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) out.push({ path, method, op });
  }
  return out;
}
function findOp(operationId: string): OperationObject | undefined {
  return operations().find((o) => o.op.operationId === operationId)?.op;
}
function schema(name: string): SchemaObject | undefined {
  return doc.components?.schemas?.[name];
}

describe("erpnext-reconciliation/reconciliation.yaml — loadability", () => {
  it("is parseable by the production OpenAPI loader", () => {
    expect(doc).toBeDefined();
    expect(typeof doc).toBe("object");
  });
  it("declares OpenAPI 3.1 of record", () => {
    expect(doc.openapi).toBe("3.1.0");
  });
  it("declares an info block with title and a *-draft version", () => {
    expect(doc.info?.title).toEqual(expect.any(String));
    expect(doc.info?.version).toEqual(expect.stringMatching(/-draft$/));
  });
});

describe("erpnext-reconciliation/reconciliation.yaml — operations", () => {
  it("declares all six 017 operationIds", () => {
    for (const id of OPERATION_IDS) expect(findOp(id)).toBeDefined();
  });
  it("does NOT collide with or rename any shipped operationId", () => {
    for (const id of OPERATION_IDS) expect(shippedOperationIds.has(id)).toBe(false);
  });
  it("routes all ops under /api/v1/catalog/erpnext-reconciliation (not /api/admin, not /api/connector)", () => {
    for (const { path } of operations()) {
      expect(path.startsWith("/api/v1/catalog/erpnext-reconciliation")).toBe(true);
    }
  });
});

describe("erpnext-reconciliation/reconciliation.yaml — auth boundary (FR-018)", () => {
  it("defines the cookieAuth (httpOnly dp2_session) scheme", () => {
    const cookie = doc.components?.securitySchemes?.["cookieAuth"];
    expect(cookie?.["type"]).toBe("apiKey");
    expect(cookie?.["in"]).toBe("cookie");
    expect(cookie?.["name"]).toBe("dp2_session");
  });
  it("requires cookieAuth at the document level", () => {
    expect(doc.security).toEqual([{ cookieAuth: [] }]);
  });
  it("does NOT define connectorBearer (012 machine) or clerkJwt (POS device)", () => {
    expect(doc.components?.securitySchemes?.["connectorBearer"]).toBeUndefined();
    expect(doc.components?.securitySchemes?.["clerkJwt"]).toBeUndefined();
  });
});

describe("erpnext-reconciliation/reconciliation.yaml — idempotency (O-3, no new primitive)", () => {
  it("the three mutating ops require an Idempotency-Key header", () => {
    for (const id of MUTATING_IDEMPOTENT_OPS) {
      const op = findOp(id);
      // The IdempotencyKey param is a $ref; resolve by checking the referenced name.
      const hasKeyRef = (op?.parameters ?? []).some(
        (p) => p.$ref?.endsWith("/IdempotencyKey") || p.name === "Idempotency-Key",
      );
      expect(hasKeyRef).toBe(true);
    }
  });
});

describe("erpnext-reconciliation/reconciliation.yaml — request DTOs (§XII)", () => {
  it("trigger-run request is strict and carries ONLY storeId (no tenant/kind/trigger/actor)", () => {
    const s = schema("TriggerRunRequest");
    expect(s?.additionalProperties).toBe(false);
    expect(s?.required).toEqual(["storeId"]);
    for (const forbidden of ["tenant_id", "tenantId", "kind", "trigger", "actor_user_id"]) {
      expect(s?.properties?.[forbidden]).toBeUndefined();
    }
  });
  it("stock-repair request is strict (repairKind + optional note only)", () => {
    const s = schema("RepairStockRequest");
    expect(s?.additionalProperties).toBe(false);
    expect(s?.required).toEqual(["repairKind"]);
    for (const forbidden of ["tenant_id", "result_state", "actor_user_id"]) {
      expect(s?.properties?.[forbidden]).toBeUndefined();
    }
  });
  it("posting-repair request is strict (no body-supplied identity/actor)", () => {
    const s = schema("RepairPostingRequest");
    expect(s?.additionalProperties).toBe(false);
    for (const forbidden of ["tenant_id", "workItemRef", "status", "actor_user_id"]) {
      expect(s?.properties?.[forbidden]).toBeUndefined();
    }
  });
});

describe("erpnext-reconciliation/reconciliation.yaml — error envelope", () => {
  it("the mutating ops declare 409 (idempotency_key_conflict) + non-disclosing 404", () => {
    for (const id of MUTATING_IDEMPOTENT_OPS) {
      const responses = findOp(id)?.responses ?? {};
      expect(responses["404"]).toBeDefined();
      expect(responses["409"]).toBeDefined();
    }
  });
  it("Error is the strict canonical envelope { error: { code, message, request_id? } }", () => {
    const err = schema("Error");
    expect(err?.additionalProperties).toBe(false);
    expect(err?.required).toEqual(["error"]);
  });
});

describe("erpnext-reconciliation/reconciliation.yaml — projections (READ-NOT-MIRROR, no money)", () => {
  it("ReconciliationResult.mismatchClass is 014's vocabulary ONLY (no 015 posting categories)", () => {
    const cls = schema("ReconciliationResult")?.properties?.["mismatchClass"]?.enum ?? [];
    expect(cls.sort()).toEqual([
      "dp2_only", "erpnext_only", "match", "negative_balance_flagged",
      "quantity_divergence", "unmapped_item", "unmapped_store",
    ]);
    // The 015 posting categories must NOT leak into the 017 result class.
    for (const posting of ["validation", "closed_period", "unmapped_account", "retry_budget_exhausted"]) {
      expect(cls).not.toContain(posting);
    }
  });
  it("ReconciliationRun.kind is stock-only (the backlog is a read-projection, not a run)", () => {
    const kind = schema("ReconciliationRun")?.properties?.["kind"]?.enum ?? [];
    expect(kind).toEqual(["stock"]);
  });
  it("no projection carries a money / valuation / on-hand field", () => {
    for (const name of ["PostingBacklogItem", "ReconciliationRun", "ReconciliationResult", "RecordedRepair"]) {
      const props = schema(name)?.properties ?? {};
      for (const forbidden of ["amount", "pos_total", "valuation", "cost", "price", "on_hand", "stock_value"]) {
        expect(props[forbidden]).toBeUndefined();
      }
    }
  });
  it("all projections are strict (no raw DB entity, §IV)", () => {
    for (const name of ["PostingBacklogItem", "ReconciliationRun", "ReconciliationResult", "RecordedRepair", "PostingBacklogPage", "ReconciliationResultPage"]) {
      expect(schema(name)?.additionalProperties).toBe(false);
    }
  });
});
