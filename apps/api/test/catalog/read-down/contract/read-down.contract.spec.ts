/**
 * apps/api/test/catalog/read-down/contract/read-down.contract.spec.ts
 *
 * Slice 010-CONTRACT (T010 + T011) — OpenAPI conformance test for
 * `packages/contracts/openapi/catalog/read-down.yaml`.
 *
 * Mirrors `apps/api/test/catalog/sales/contract/sales.contract.spec.ts`:
 *
 *   * Loads the new contract via the production `loadOpenApiContracts` helper
 *     with an explicit `dir`, because the helper's directory scan is
 *     non-recursive (`apps/api/src/openapi/loader.ts` — `readdirSync(dir)` with
 *     no recursive flag). The nested `catalog/` sub-directory is therefore NOT
 *     picked up by the umbrella `loadOpenApiContracts()` call, so it loads here
 *     explicitly. T011 is consequently a no-op: there is no central YAML
 *     registry to extend (same verdict as 005 T504 / 008 T011).
 *
 *   * Asserts presence of the two 010 operationIds (`posGetCatalogSnapshot`,
 *     `posGetCatalogDeltas`) and their UNIQUENESS against every shipped
 *     operationId — both the top-level contracts AND the nested `catalog/` +
 *     `pos-sales/` siblings (the slice's stop condition is "if any operationId
 *     collides with or renames a shipped 005/007/008 operationId").
 *
 *   * Verifies structural conventions shared with the other contracts: OpenAPI
 *     3.1 of record, the role-named `device` security scheme defined + referenced
 *     on both ops (spec 030; was `clerkJwt`), opaque cursor + `next_page_token`, decimal-money `price { amount,
 *     currency_code }`, the `toBody()` sellable-row shape (no raw DB entity), and
 *     the closed error set incl. `snapshot_required` riding the canonical `Error`
 *     envelope.
 *
 * The spec is structural / load-only (no app boot, no HTTP requests). The
 * controller / service are authored in 010-US1-SNAPSHOT onward.
 */
import "reflect-metadata";

import { resolve } from "node:path";

import { loadOpenApiContracts } from "../../../../src/openapi/loader";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEW_CONTRACT_ID = "read-down";

const OPERATION_IDS = ["posGetCatalogSnapshot", "posGetCatalogDeltas"] as const;

const SNAPSHOT_PATH = "/api/pos/v1/catalog/snapshot";
const DELTAS_PATH = "/api/pos/v1/catalog/deltas";

/**
 * Resolve a `packages/contracts/openapi/<sub>` directory from this spec's
 * location:
 *   apps/api/test/catalog/read-down/contract/read-down.contract.spec.ts
 *   →  ../../../../../..   = <repo root>
 */
function openapiSubDir(sub: string): string {
  return resolve(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "..",
    "packages",
    "contracts",
    "openapi",
    sub,
  );
}

// ---------------------------------------------------------------------------
// Shared types — keep narrow; the loader returns `unknown` documents.
// ---------------------------------------------------------------------------

interface OperationObject {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{
    $ref?: string;
    in?: string;
    name?: string;
    required?: boolean;
    schema?: Record<string, unknown>;
  }>;
  responses?: Record<string, unknown>;
}

type PathItem = Record<string, OperationObject>;

interface SchemaObject {
  type?: string | string[];
  additionalProperties?: boolean | Record<string, unknown>;
  required?: string[];
  properties?: Record<string, unknown>;
}

interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    securitySchemes?: Record<string, Record<string, unknown>>;
    parameters?: Record<string, Record<string, unknown>>;
    responses?: Record<string, Record<string, unknown>>;
  };
  security?: Array<Record<string, unknown>>;
  tags?: Array<{ name?: string }>;
}

let readDownDoc: OpenApiDocument;
let shippedOperationIds: Set<string>;

function collectOperationIds(docs: OpenApiDocument[], into: Set<string>): void {
  for (const doc of docs) {
    if (!doc.paths) continue;
    for (const path of Object.values(doc.paths)) {
      for (const op of Object.values(path)) {
        if (op && typeof op.operationId === "string") into.add(op.operationId);
      }
    }
  }
}

beforeAll(() => {
  const catalogContracts = loadOpenApiContracts({ dir: openapiSubDir("catalog") });
  const newContract = catalogContracts.find((c) => c.id === NEW_CONTRACT_ID);
  if (!newContract) {
    const ids = catalogContracts.map((c) => c.id).join(", ");
    throw new Error(
      `${NEW_CONTRACT_ID} contract not found under ${openapiSubDir("catalog")}; loaded ids: [${ids}]`,
    );
  }
  readDownDoc = newContract.document as OpenApiDocument;

  // Build the set of SHIPPED operationIds the new ops must not collide with:
  // the top-level contracts PLUS the nested catalog/ + pos-sales/ siblings
  // (the umbrella loader is non-recursive, so it would otherwise miss
  // unknown-items.yaml / sales.yaml — exactly the 005/007/008 surfaces the
  // stop condition guards). Exclude the new read-down contract itself.
  shippedOperationIds = new Set<string>();
  collectOperationIds(
    loadOpenApiContracts().map((c) => c.document as OpenApiDocument),
    shippedOperationIds,
  );
  collectOperationIds(
    catalogContracts
      .filter((c) => c.id !== NEW_CONTRACT_ID)
      .map((c) => c.document as OpenApiDocument),
    shippedOperationIds,
  );
  collectOperationIds(
    loadOpenApiContracts({ dir: openapiSubDir("pos-sales") }).map(
      (c) => c.document as OpenApiDocument,
    ),
    shippedOperationIds,
  );
});

function readDownOperations(): Array<{
  path: string;
  method: string;
  op: OperationObject;
}> {
  const out: Array<{ path: string; method: string; op: OperationObject }> = [];
  for (const [path, item] of Object.entries(readDownDoc.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      out.push({ path, method, op });
    }
  }
  return out;
}

function findOp(operationId: string): OperationObject | undefined {
  return readDownOperations().find((o) => o.op.operationId === operationId)?.op;
}

// ===========================================================================
// 1. Loadability + document-level conventions
// ===========================================================================
describe("catalog/read-down.yaml — loadability", () => {
  it("is parseable by the production OpenAPI loader", () => {
    expect(readDownDoc).toBeDefined();
    expect(typeof readDownDoc).toBe("object");
  });

  it("declares OpenAPI 3.1 of record", () => {
    expect(readDownDoc.openapi).toBe("3.1.0");
  });

  it("declares an info block with title and a *-draft version", () => {
    expect(readDownDoc.info?.title).toEqual(expect.any(String));
    expect(readDownDoc.info?.version).toEqual(expect.stringMatching(/-draft$/));
  });

  it("declares the role-named device security scheme, NO bearerFormat JWT (spec 030)", () => {
    // Spec 030 retired the provider-named `clerkJwt` key here and introduced
    // the role-named `device` scheme — an opaque device token, so
    // `bearerFormat: JWT` is deliberately omitted.
    const scheme = readDownDoc.components?.securitySchemes?.["device"] as
      | { type?: string; scheme?: string; bearerFormat?: string }
      | undefined;
    expect(scheme).toBeDefined();
    expect(scheme?.type).toBe("http");
    expect(scheme?.scheme).toBe("bearer");
    expect(scheme?.bearerFormat).toBeUndefined();
    expect(readDownDoc.components?.securitySchemes?.["clerkJwt"]).toBeUndefined();
  });
});

// ===========================================================================
// 2. Operations present, uniquely named, POS-secured, read-only
// ===========================================================================
describe("catalog/read-down.yaml — operations", () => {
  it("declares exactly the two 010 operationIds", () => {
    const ids = readDownOperations()
      .map((o) => o.op.operationId)
      .filter((id): id is string => typeof id === "string")
      .sort();
    expect(ids).toEqual([...OPERATION_IDS].sort());
  });

  it("maps each operationId to its expected GET path", () => {
    expect(readDownDoc.paths?.[SNAPSHOT_PATH]?.["get"]?.operationId).toBe(
      "posGetCatalogSnapshot",
    );
    expect(readDownDoc.paths?.[DELTAS_PATH]?.["get"]?.operationId).toBe(
      "posGetCatalogDeltas",
    );
  });

  it("is READ-ONLY — only GET methods, no write verbs", () => {
    const methods = readDownOperations().map((o) => o.method.toLowerCase());
    for (const m of methods) expect(m).toBe("get");
    for (const verb of ["post", "put", "patch", "delete"]) {
      expect(readDownDoc.paths?.[SNAPSHOT_PATH]?.[verb]).toBeUndefined();
      expect(readDownDoc.paths?.[DELTAS_PATH]?.[verb]).toBeUndefined();
    }
  });

  it("does NOT collide with or rename any shipped operationId (005/007/008 + top-level)", () => {
    for (const id of OPERATION_IDS) {
      expect(shippedOperationIds.has(id)).toBe(false);
    }
  });

  it("secures every operation with the role-named device scheme (spec 030)", () => {
    for (const { op } of readDownOperations()) {
      expect(op.security).toContainEqual({ device: [] });
      expect(op.security).not.toContainEqual({ clerkJwt: [] });
    }
  });
});

// ===========================================================================
// 3. Cursor + pagination contract
// ===========================================================================
describe("catalog/read-down.yaml — cursor + pagination", () => {
  it("deltas REQUIRES the opaque `since` cursor", () => {
    const params = findOp("posGetCatalogDeltas")?.parameters ?? [];
    const sinceRef = params.some(
      (p) => p.$ref === "#/components/parameters/Since",
    );
    expect(sinceRef).toBe(true);
    const since = readDownDoc.components?.parameters?.["Since"] as
      | { name?: string; in?: string; required?: boolean }
      | undefined;
    expect(since?.name).toBe("since");
    expect(since?.in).toBe("query");
    expect(since?.required).toBe(true);
  });

  it("snapshot does NOT require a `since` cursor (it issues the first one)", () => {
    const params = findOp("posGetCatalogSnapshot")?.parameters ?? [];
    expect(params.some((p) => p.$ref === "#/components/parameters/Since")).toBe(
      false,
    );
  });

  it("both pages carry `next_page_token` (opaque continuation)", () => {
    const snap = readDownDoc.components?.schemas?.["CatalogSnapshotPage"];
    const delta = readDownDoc.components?.schemas?.["CatalogDeltaPage"];
    expect(snap?.properties).toHaveProperty("next_page_token");
    expect(snap?.required).toContain("next_page_token");
    expect(delta?.properties).toHaveProperty("next_page_token");
    expect(delta?.required).toContain("next_page_token");
  });

  it("locks the per-row token name as `row_cursor` (analyze I2/R-5)", () => {
    const row = readDownDoc.components?.schemas?.["SellableCatalogRow"];
    expect(row?.properties).toHaveProperty("row_cursor");
    expect(row?.required).toContain("row_cursor");
    // It is NOT named `cursor` or `row_version` on the row.
    expect(row?.properties).not.toHaveProperty("row_version");
  });
});

// ===========================================================================
// 4. Payload — decimal money, toBody projection, real-schema-backed only
// ===========================================================================
describe("catalog/read-down.yaml — payload (decimal money, toBody, R-1)", () => {
  it("price is { amount: DecimalAmount, currency_code: CurrencyCode } — never a float", () => {
    const money = readDownDoc.components?.schemas?.["Money"];
    expect(money?.required).toEqual(
      expect.arrayContaining(["amount", "currency_code"]),
    );
    const props = (money?.properties ?? {}) as Record<
      string,
      { $ref?: string }
    >;
    expect(props["amount"]?.$ref).toBe("#/components/schemas/DecimalAmount");
    expect(props["currency_code"]?.$ref).toBe(
      "#/components/schemas/CurrencyCode",
    );
    // DecimalAmount is a string with the no-float pattern.
    const amount = readDownDoc.components?.schemas?.["DecimalAmount"] as
      | { type?: string; pattern?: string }
      | undefined;
    expect(amount?.type).toBe("string");
    expect(amount?.pattern).toBeDefined();
  });

  it("the sellable row is a strict toBody projection (additionalProperties: false)", () => {
    const row = readDownDoc.components?.schemas?.["SellableCatalogRow"];
    expect(row?.additionalProperties).toBe(false);
    expect(row?.required).toEqual(
      expect.arrayContaining([
        "product_id",
        "sku",
        "name",
        "aliases",
        "price",
        "tax_category",
        "active",
        "row_cursor",
      ]),
    );
  });

  it("does NOT carry the removed pharmacy fields (R-1/Option B — no backing column)", () => {
    const props =
      readDownDoc.components?.schemas?.["SellableCatalogRow"]?.properties ?? {};
    for (const removed of [
      "name_ar",
      "name_en",
      "controlled_substance",
      "prescription_required",
      "unit_pack_label",
    ]) {
      expect(props).not.toHaveProperty(removed);
    }
  });

  it("the delta op enumerates upsert | remove_from_sellable (row omitted on removal)", () => {
    const opSchema = readDownDoc.components?.schemas?.["CatalogDeltaOp"];
    const opProp = (opSchema?.properties ?? {})["op"] as
      | { enum?: string[] }
      | undefined;
    expect(opProp?.enum?.sort()).toEqual(
      ["remove_from_sellable", "upsert"].sort(),
    );
    // `row` is NOT required (omitted for remove_from_sellable).
    expect(opSchema?.required ?? []).not.toContain("row");
  });
});

// ===========================================================================
// 5. Error envelope + closed error set (snapshot_required rides Error)
// ===========================================================================
describe("catalog/read-down.yaml — error vocabulary", () => {
  it("defines the canonical Error envelope { error: { code, message } } (no details)", () => {
    const errorSchema = readDownDoc.components?.schemas?.["Error"] as
      | { required?: string[]; properties?: { error?: { properties?: Record<string, unknown> } } }
      | undefined;
    expect(errorSchema?.required).toContain("error");
    const inner = errorSchema?.properties?.error?.properties ?? {};
    expect(Object.keys(inner).sort()).toEqual(
      ["code", "message", "request_id"].sort(),
    );
    expect(inner).not.toHaveProperty("details");
  });

  it("declares the closed error-response set incl. snapshot_required", () => {
    const responses = readDownDoc.components?.responses ?? {};
    for (const name of [
      "ValidationFailure",
      "Unauthorized",
      "NotFound",
      "SnapshotRequired",
      "SystemFailure",
    ]) {
      expect(responses[name]).toBeDefined();
    }
  });

  it("maps snapshot to 200/400/401/404/500 and deltas to 200/400/401/404/409/500", () => {
    const snap = readDownDoc.paths?.[SNAPSHOT_PATH]?.["get"]?.responses ?? {};
    expect(Object.keys(snap)).toEqual(
      expect.arrayContaining(["200", "400", "401", "404", "500"]),
    );
    const delta = readDownDoc.paths?.[DELTAS_PATH]?.["get"]?.responses ?? {};
    expect(Object.keys(delta)).toEqual(
      expect.arrayContaining(["200", "400", "401", "404", "409", "500"]),
    );
  });

  it("the 409 on deltas is the snapshot_required re-baseline (FR-023)", () => {
    const delta = readDownDoc.paths?.[DELTAS_PATH]?.["get"]?.responses ?? {};
    const conflict = delta["409"] as { $ref?: string } | undefined;
    expect(conflict?.$ref).toBe("#/components/responses/SnapshotRequired");
  });
});

// ===========================================================================
// 6. Read-only / object-safety invariants
// ===========================================================================
describe("catalog/read-down.yaml — read-only + object safety", () => {
  it("declares no request body on any operation (read-only surface)", () => {
    for (const { op } of readDownOperations()) {
      expect(op).not.toHaveProperty("requestBody");
    }
  });

  it("page + row + op + money schemas are all strict (additionalProperties: false)", () => {
    const schemas = readDownDoc.components?.schemas ?? {};
    for (const name of [
      "CatalogSnapshotPage",
      "CatalogDeltaPage",
      "CatalogDeltaOp",
      "SellableCatalogRow",
      "Money",
    ]) {
      expect(schemas[name]?.additionalProperties).toBe(false);
    }
  });

  it("declares no money/payload field NAMES that leak a raw DB column (§IV)", () => {
    // The sellable row exposes only the curated toBody fields — no raw columns
    // (default_price, default_currency_code, retired_at, is_active, etc.).
    const props =
      readDownDoc.components?.schemas?.["SellableCatalogRow"]?.properties ?? {};
    for (const rawCol of [
      "default_price",
      "default_currency_code",
      "retired_at",
      "is_active",
      "tenant_id",
      "store_id",
      "created_by",
      "updated_by",
    ]) {
      expect(props).not.toHaveProperty(rawCol);
    }
  });
});
