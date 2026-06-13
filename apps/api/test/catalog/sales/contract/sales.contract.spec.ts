/**
 * apps/api/test/catalog/sales/contract/sales.contract.spec.ts
 *
 * Slice 008-CONTRACT (T010 + T011) — OpenAPI conformance test for
 * `packages/contracts/openapi/pos-sales/sales.yaml`.
 *
 * Mirrors `apps/api/test/catalog/unknown-items/contract.spec.ts`:
 *
 *   * Loads the new contract via the production `loadOpenApiContracts`
 *     helper with an explicit `dir`, because the helper's directory scan is
 *     non-recursive (`apps/api/src/openapi/loader.ts` uses `readdirSync(dir)`
 *     with no recursive flag). The nested `pos-sales/` sub-directory is
 *     therefore NOT picked up by the umbrella `loadOpenApiContracts()` call,
 *     so it must be loaded explicitly here. T011 is consequently a no-op:
 *     there is no central YAML registry to extend (same verdict as 005 T504).
 *
 *   * Asserts presence of the four 008 operationIds (`captureSale`,
 *     `recordVoid`, `recordRefund`, `readSale`) and their uniqueness against
 *     the existing top-level contracts (the slice's stop condition is "if any
 *     operationId collides with or renames a shipped 005/007 operationId").
 *
 *   * Asserts the write operations declare the REQUIRED `Idempotency-Key`
 *     header (FR-051), aligning with the existing `IdempotencyInterceptor`
 *     and the `posCaptureItem` precedent.
 *
 *   * Verifies structural conventions shared with the other contracts:
 *     OpenAPI 3.1 of record, `clerkJwt` POS security scheme defined and
 *     referenced, canonical `Error` envelope, and the FR-101 failure-category
 *     responses. No tender fields appear (gate A.5).
 *
 * The spec is structural / load-only (no app boot, no HTTP requests). The
 * controller / service are authored in the 008-US1-CAPTURE slice onward.
 */
import "reflect-metadata";

import { resolve } from "node:path";

import { loadOpenApiContracts } from "../../../../src/openapi/loader";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEW_CONTRACT_ID = "sales";

const OPERATION_IDS = [
  "captureSale",
  "recordVoid",
  "recordRefund",
  "readSale",
] as const;

const WRITE_OPERATION_IDS = ["captureSale", "recordVoid", "recordRefund"];

const CAPTURE_PATH = "/api/pos/v1/sales";
const READ_PATH = "/api/pos/v1/sales/{saleRef}";
const VOID_PATH = "/api/pos/v1/sales/{saleRef}/void";
const REFUND_PATH = "/api/pos/v1/sales/{saleRef}/refund";

/**
 * Resolve the pos-sales contract directory from this spec file's location.
 *
 * Layout:
 *   apps/api/test/catalog/sales/contract/sales.contract.spec.ts
 *   →  ../../../../../..        = <repo root>
 *   →  ../../../../../../packages/contracts/openapi/pos-sales
 */
function posSalesContractsDir(): string {
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
    "pos-sales",
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
  requestBody?: Record<string, unknown>;
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

// Lazy-loaded once per file; populated in beforeAll.
let salesDoc: OpenApiDocument;
let topLevelOperationIds: Set<string>;

beforeAll(() => {
  const posSalesContracts = loadOpenApiContracts({ dir: posSalesContractsDir() });
  const newContract = posSalesContracts.find((c) => c.id === NEW_CONTRACT_ID);
  if (!newContract) {
    const ids = posSalesContracts.map((c) => c.id).join(", ");
    throw new Error(
      `${NEW_CONTRACT_ID} contract not found under ${posSalesContractsDir()}; loaded ids: [${ids}]`,
    );
  }
  salesDoc = newContract.document as OpenApiDocument;

  // Build the set of operationIds across the *existing* top-level contracts
  // so the uniqueness check below can reject any collision/rename. We call
  // the default-dir loader (no `dir:` override) to exercise the same surface
  // the production startup uses.
  const topLevelContracts = loadOpenApiContracts();
  topLevelOperationIds = new Set<string>();
  for (const contract of topLevelContracts) {
    const doc = contract.document as OpenApiDocument;
    if (!doc.paths) continue;
    for (const path of Object.values(doc.paths)) {
      for (const op of Object.values(path)) {
        if (op && typeof op.operationId === "string") {
          topLevelOperationIds.add(op.operationId);
        }
      }
    }
  }
});

// Helper — flatten every operation in the new contract.
function salesOperations(): Array<{
  path: string;
  method: string;
  op: OperationObject;
}> {
  const out: Array<{ path: string; method: string; op: OperationObject }> = [];
  const paths = salesDoc.paths ?? {};
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      out.push({ path, method, op });
    }
  }
  return out;
}

function findOp(operationId: string): OperationObject | undefined {
  return salesOperations().find((o) => o.op.operationId === operationId)?.op;
}

// ===========================================================================
// 1. Loadability + document-level conventions
// ===========================================================================
describe("pos-sales/sales.yaml — loadability", () => {
  it("is parseable by the production OpenAPI loader", () => {
    expect(salesDoc).toBeDefined();
    expect(typeof salesDoc).toBe("object");
  });

  it("declares OpenAPI 3.1 of record (matches the other contracts in this repo)", () => {
    expect(salesDoc.openapi).toBe("3.1.0");
  });

  it("declares an info block with title and a *-draft version", () => {
    expect(salesDoc.info?.title).toEqual(expect.any(String));
    expect(salesDoc.info?.version).toEqual(expect.stringMatching(/-draft$/));
  });

  it("declares the operatorAuthorization scheme (031 D1+D2 envelope; NOT clerkJwt)", () => {
    const schemes = salesDoc.components?.securitySchemes ?? {};
    // 031 retired clerkJwt on the sale routes in favour of the opaque
    // operator-authorization envelope; the old Clerk-JWT scheme is gone.
    expect(schemes["operatorAuthorization"]).toBeDefined();
    expect(schemes["clerkJwt"]).toBeUndefined();
    // The envelope is opaque, not a JWT — no bearerFormat.
    const scheme = schemes["operatorAuthorization"] as { type?: string; scheme?: string; bearerFormat?: string };
    expect(scheme.type).toBe("http");
    expect(scheme.scheme).toBe("bearer");
    expect(scheme.bearerFormat).toBeUndefined();
    // MUST NOT reuse spec 030's identity-proof-only scheme.
    expect(schemes["operator-identity"]).toBeUndefined();
  });
});

// ===========================================================================
// 2. Operations present, uniquely named, POS-secured
// ===========================================================================
describe("pos-sales/sales.yaml — operations", () => {
  it("declares exactly the four 008 operationIds", () => {
    const ids = salesOperations()
      .map((o) => o.op.operationId)
      .filter((id): id is string => typeof id === "string")
      .sort();
    expect(ids).toEqual([...OPERATION_IDS].sort());
  });

  it("maps each operationId to its expected path", () => {
    expect(findOp("captureSale")).toBeDefined();
    expect(salesDoc.paths?.[CAPTURE_PATH]?.["post"]?.operationId).toBe("captureSale");
    expect(salesDoc.paths?.[READ_PATH]?.["get"]?.operationId).toBe("readSale");
    expect(salesDoc.paths?.[VOID_PATH]?.["post"]?.operationId).toBe("recordVoid");
    expect(salesDoc.paths?.[REFUND_PATH]?.["post"]?.operationId).toBe("recordRefund");
  });

  it("does NOT collide with or rename any shipped top-level operationId", () => {
    for (const id of OPERATION_IDS) {
      expect(topLevelOperationIds.has(id)).toBe(false);
    }
  });

  it("secures every operation with the operatorAuthorization envelope (031 D1+D2)", () => {
    for (const { op } of salesOperations()) {
      expect(op.security).toContainEqual({ operatorAuthorization: [] });
    }
  });
});

// ===========================================================================
// 3. Idempotency — required Idempotency-Key on every write
// ===========================================================================
describe("pos-sales/sales.yaml — idempotency", () => {
  it("requires the Idempotency-Key header on every write operation", () => {
    for (const id of WRITE_OPERATION_IDS) {
      const op = findOp(id);
      expect(op).toBeDefined();
      const params = op?.parameters ?? [];
      // The header is declared via a $ref to components.parameters.IdempotencyKey.
      const hasIdempotencyRef = params.some(
        (p) => p.$ref === "#/components/parameters/IdempotencyKey",
      );
      expect(hasIdempotencyRef).toBe(true);
    }
    // The shared parameter itself is REQUIRED and named correctly.
    const idemParam = salesDoc.components?.parameters?.["IdempotencyKey"] as
      | { name?: string; in?: string; required?: boolean }
      | undefined;
    expect(idemParam?.name).toBe("Idempotency-Key");
    expect(idemParam?.in).toBe("header");
    expect(idemParam?.required).toBe(true);
  });

  it("does NOT require an Idempotency-Key on the read", () => {
    const params = findOp("readSale")?.parameters ?? [];
    const hasIdempotencyRef = params.some(
      (p) => p.$ref === "#/components/parameters/IdempotencyKey",
    );
    expect(hasIdempotencyRef).toBe(false);
  });
});

// ===========================================================================
// 4. Error envelope + FR-101 failure categories
// ===========================================================================
describe("pos-sales/sales.yaml — error vocabulary", () => {
  it("defines a canonical Error envelope { error: { code, message } }", () => {
    const errorSchema = salesDoc.components?.schemas?.["Error"];
    expect(errorSchema).toBeDefined();
    expect(errorSchema?.required).toContain("error");
  });

  it("declares the FR-101 failure-category responses", () => {
    const responses = salesDoc.components?.responses ?? {};
    for (const name of [
      "ValidationFailure",
      "Unauthorized",
      "NotFound",
      "Conflict",
      "AlreadyApplied",
      "SystemFailure",
    ]) {
      expect(responses[name]).toBeDefined();
    }
  });

  it("maps capture to 200(replay)/201/400/401/409/500 and reads to 200/401/404", () => {
    const capture = salesDoc.paths?.[CAPTURE_PATH]?.["post"]?.responses ?? {};
    expect(Object.keys(capture)).toEqual(
      expect.arrayContaining(["200", "201", "400", "401", "409", "500"]),
    );
    const read = salesDoc.paths?.[READ_PATH]?.["get"]?.responses ?? {};
    expect(Object.keys(read)).toEqual(
      expect.arrayContaining(["200", "401", "404", "500"]),
    );
  });

  it("declares a documented 200 idempotent-replay (Idempotent-Replayed header) on every write", () => {
    for (const p of [CAPTURE_PATH, VOID_PATH, REFUND_PATH]) {
      const post = salesDoc.paths?.[p]?.["post"];
      const ok = (post?.responses ?? {})["200"] as
        | { headers?: Record<string, unknown> }
        | undefined;
      expect(ok).toBeDefined();
      expect(ok?.headers).toHaveProperty("Idempotent-Replayed");
    }
  });
});

// ===========================================================================
// 5. Object-safety + no-tender invariants encoded in the contract
// ===========================================================================
describe("pos-sales/sales.yaml — object safety + gate A.5 (no tender)", () => {
  it("declares strict request schemas (additionalProperties: false)", () => {
    const schemas = salesDoc.components?.schemas ?? {};
    for (const name of [
      "CaptureSaleRequest",
      "CaptureSaleLine",
      "RecordVoidRequest",
      "RecordRefundRequest",
    ]) {
      expect(schemas[name]?.additionalProperties).toBe(false);
    }
  });

  it("does NOT accept body-supplied tenant/store/actor on capture (FR-061)", () => {
    const props = salesDoc.components?.schemas?.["CaptureSaleRequest"]?.properties ?? {};
    for (const banned of [
      "tenant_id",
      "tenantId",
      "store_id",
      "storeId",
      "created_by",
      "createdBy",
      "received_at",
      "receivedAt",
      "business_date",
      "businessDate",
      "processed_at",
      "processedAt",
      "mismatch_flag",
      "mismatchFlag",
    ]) {
      expect(props).not.toHaveProperty(banned);
    }
  });

  it("declares no tender/payment field NAMES in any schema (gate A.5)", () => {
    // Gate A.5 bans tender/payment *fields* — not the word "tender" in the
    // prose (the description legitimately states tender is deferred to 010).
    // So inspect property names across every component schema, not the whole
    // serialized document.
    const bannedFieldFragments = [
      "tender",
      "paymentmethod",
      "payment_method",
      "card",
      "cash",
    ];
    const schemas = salesDoc.components?.schemas ?? {};
    const offending: string[] = [];
    for (const [schemaName, schema] of Object.entries(schemas)) {
      for (const prop of Object.keys(schema.properties ?? {})) {
        const lower = prop.toLowerCase();
        if (bannedFieldFragments.some((banned) => lower.includes(banned))) {
          offending.push(`${schemaName}.${prop}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });
});

// ===========================================================================
// 6. CodeRabbit review invariants (PR #422)
// ===========================================================================
describe("pos-sales/sales.yaml — review-hardening invariants", () => {
  function props(schema: string): Record<string, unknown> {
    return (salesDoc.components?.schemas?.[schema]?.properties ?? {}) as Record<
      string,
      unknown
    >;
  }

  it("Error envelope matches the shared auth/outbox shape verbatim (no details, exactly code/message/request_id)", () => {
    const errorSchema = salesDoc.components?.schemas?.["Error"] as
      | { properties?: { error?: { properties?: Record<string, unknown> } } }
      | undefined;
    const inner = errorSchema?.properties?.error?.properties ?? {};
    expect(Object.keys(inner).sort()).toEqual(
      ["code", "message", "request_id"].sort(),
    );
    expect(inner).not.toHaveProperty("details");
  });

  it("terminal events carry no occurredAt (no occurred_at column on sale_voids/sale_refunds)", () => {
    expect(props("RecordVoidRequest")).not.toHaveProperty("occurredAt");
    expect(props("RecordRefundRequest")).not.toHaveProperty("occurredAt");
    expect(props("SaleTerminalEvent")).not.toHaveProperty("occurredAt");
    // recordedAt (server-clock stamp) is the only timestamp.
    expect(props("SaleTerminalEvent")).toHaveProperty("recordedAt");
  });

  it("nullable money/currency fields still reuse the DecimalAmount/CurrencyCode schemas (anyOf)", () => {
    const checks: Array<{ schema: string; field: string; ref: string }> = [
      { schema: "SaleLine", field: "taxAmount", ref: "#/components/schemas/DecimalAmount" },
      { schema: "SaleTerminalEvent", field: "posRefundAmount", ref: "#/components/schemas/DecimalAmount" },
      { schema: "SaleTerminalEvent", field: "currencyCode", ref: "#/components/schemas/CurrencyCode" },
    ];
    for (const { schema, field, ref } of checks) {
      const f = props(schema)[field] as { anyOf?: Array<Record<string, unknown>> } | undefined;
      expect(f?.anyOf).toBeDefined();
      const refs = (f?.anyOf ?? []).map((m) => m["$ref"]);
      const hasNull = (f?.anyOf ?? []).some((m) => m["type"] === "null");
      expect(refs).toContain(ref);
      expect(hasNull).toBe(true);
    }
  });
});
