/**
 * apps/api/test/catalog/unknown-items/contract.spec.ts
 *
 * Slice 005-WAVE1-CONTRACT (T503 + T504) — OpenAPI conformance test for
 * `packages/contracts/openapi/catalog/unknown-items.yaml`.
 *
 * Mirrors the precedent established by `apps/api/test/outbox/admin.contract.spec.ts`:
 *
 *   * Loads the new catalog YAML via the production `loadOpenApiContracts`
 *     helper, passing an explicit `dir` because the helper's default
 *     directory scan is non-recursive (`apps/api/src/openapi/loader.ts:52`
 *     uses `readdirSync(dir)` with no `recursive` flag). The nested
 *     `catalog/` sub-directory is therefore not picked up by the umbrella
 *     `loadOpenApiContracts()` call inside `contract-conformance.spec.ts`,
 *     and the new YAML must be loaded explicitly here. T504 is consequently
 *     a no-op: there is no central YAML registry to extend.
 *
 *   * Asserts presence of the three Wave 1 operationIds (`posCaptureItem`,
 *     `tenantAdminListUnknownItems`, `tenantAdminDismissUnknownItem`) and
 *     uniqueness against the existing top-level contracts (the slice's
 *     stop condition is "if the YAML edits any existing operationId").
 *
 *   * Asserts the POS capture operation declares the `Idempotency-Key`
 *     header (not `Idempotency-Token`), aligning with the existing
 *     `IdempotencyInterceptor` and the `createInvitation` precedent in
 *     `packages/contracts/openapi/memberships.openapi.yaml`.
 *
 *   * Verifies structural conventions shared with the other contracts:
 *     OpenAPI 3.1 of record, security schemes defined and referenced,
 *     `Error` envelope shape consistent with `outbox.openapi.yaml`.
 *
 * The spec is structural / load-only (no app boot, no HTTP requests). The
 * controller / service for the Wave 1 capture path is authored in later
 * slices (`005-WAVE1-CAPTURE-HAPPY` onwards); the behavioural conformance
 * tests for that path will be added under
 * `apps/api/test/catalog/unknown-items/capture/` per the execution-map.
 */
import "reflect-metadata";

import { resolve } from "node:path";

import { loadOpenApiContracts } from "../../../src/openapi/loader";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEW_CONTRACT_ID = "unknown-items";

const WAVE_1_OPERATION_IDS = [
  "posCaptureItem",
  "tenantAdminListUnknownItems",
  "tenantAdminDismissUnknownItem",
] as const;

const POS_CAPTURE_PATH = "/api/pos/v1/catalog/unknown-items";
const TENANT_ADMIN_LIST_PATH = "/api/v1/catalog/unknown-items";
const TENANT_ADMIN_DISMISS_PATH =
  "/api/v1/catalog/unknown-items/{id}/dismiss";

/**
 * Resolve the catalog contract directory from this spec file's location.
 * The path is computed relative to `__dirname` at runtime so it is
 * stable across `ts-jest` (transpiled in-place) and any future
 * dist-based test execution.
 *
 * Layout:
 *   apps/api/test/catalog/unknown-items/contract.spec.ts
 *   →  ../../../..        = apps/
 *   →  ../../../../..     = <repo root>
 *   →  ../../../../../packages/contracts/openapi/catalog
 */
function catalogContractsDir(): string {
  return resolve(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "packages",
    "contracts",
    "openapi",
    "catalog",
  );
}

// ---------------------------------------------------------------------------
// Shared types — keep narrow; the loader returns `unknown` documents.
// ---------------------------------------------------------------------------

interface OperationObject {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{
    in?: string;
    name?: string;
    required?: boolean;
    schema?: Record<string, unknown>;
  }>;
  responses?: Record<string, unknown>;
}

type PathItem = Record<string, OperationObject>;

interface OpenApiDocument {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, Record<string, unknown>>;
    securitySchemes?: Record<string, Record<string, unknown>>;
  };
  security?: Array<Record<string, unknown>>;
  tags?: Array<{ name?: string }>;
}

// Lazy-loaded once per file; populated in beforeAll.
let catalogDoc: OpenApiDocument;
let topLevelOperationIds: Set<string>;

beforeAll(() => {
  const catalogContracts = loadOpenApiContracts({ dir: catalogContractsDir() });
  const newContract = catalogContracts.find((c) => c.id === NEW_CONTRACT_ID);
  if (!newContract) {
    const ids = catalogContracts.map((c) => c.id).join(", ");
    throw new Error(
      `${NEW_CONTRACT_ID} contract not found under ${catalogContractsDir()}; loaded ids: [${ids}]`,
    );
  }
  catalogDoc = newContract.document as OpenApiDocument;

  // Build the set of operationIds across the *existing* top-level
  // contracts so the uniqueness check below can reject any collision.
  // We deliberately call the default-dir loader (no `dir:` override) to
  // exercise the same surface the production startup uses.
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
function newContractOperations(): Array<{
  path: string;
  method: string;
  op: OperationObject;
}> {
  const out: Array<{ path: string; method: string; op: OperationObject }> = [];
  const paths = catalogDoc.paths ?? {};
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      out.push({ path, method, op });
    }
  }
  return out;
}

// ===========================================================================
// 1. Loadability + document-level conventions
// ===========================================================================
describe("catalog/unknown-items.yaml — loadability", () => {
  it("is parseable by the production OpenAPI loader", () => {
    // beforeAll has already loaded the file; reaching this expect proves
    // the YAML is well-formed and non-empty.
    expect(catalogDoc).toBeDefined();
    expect(typeof catalogDoc).toBe("object");
  });

  it("declares OpenAPI 3.1 of record (matches the other contracts in this repo)", () => {
    expect(catalogDoc.openapi).toBe("3.1.0");
  });

  it("declares an info block with title and version", () => {
    expect(catalogDoc.info?.title).toEqual(expect.any(String));
    expect(catalogDoc.info?.version).toEqual(expect.any(String));
  });

  it("declares both cookieAuth and clerkJwt security schemes (Wave 1 uses both)", () => {
    const schemes = catalogDoc.components?.securitySchemes ?? {};
    expect(schemes["cookieAuth"]).toBeDefined();
    expect(schemes["clerkJwt"]).toBeDefined();
  });

  it("declares a tenant-admin default security at the document level (cookieAuth)", () => {
    // POS endpoints override with `clerkJwt`; tenant-admin endpoints
    // inherit the document-level `cookieAuth`. Matches the pattern used
    // by `outbox.openapi.yaml` and `memberships.openapi.yaml`.
    expect(catalogDoc.security).toBeDefined();
    expect(catalogDoc.security).toContainEqual({ cookieAuth: [] });
  });
});

// ===========================================================================
// 2. Operation presence + uniqueness vs. existing top-level contracts
// ===========================================================================
describe("catalog/unknown-items.yaml — Wave 1 operationIds", () => {
  it.each(WAVE_1_OPERATION_IDS)(
    "declares the %s operationId",
    (expected) => {
      const ids = newContractOperations()
        .map(({ op }) => op.operationId)
        .filter((id): id is string => typeof id === "string");
      expect(ids).toContain(expected);
    },
  );

  it("posCaptureItem is mounted at POST /api/pos/v1/catalog/unknown-items", () => {
    const posCapture = catalogDoc.paths?.[POS_CAPTURE_PATH]?.["post"];
    expect(posCapture?.operationId).toBe("posCaptureItem");
  });

  it("tenantAdminListUnknownItems is mounted at GET /api/v1/catalog/unknown-items", () => {
    const list = catalogDoc.paths?.[TENANT_ADMIN_LIST_PATH]?.["get"];
    expect(list?.operationId).toBe("tenantAdminListUnknownItems");
  });

  it("tenantAdminDismissUnknownItem is mounted at POST /api/v1/catalog/unknown-items/{id}/dismiss", () => {
    const dismiss = catalogDoc.paths?.[TENANT_ADMIN_DISMISS_PATH]?.["post"];
    expect(dismiss?.operationId).toBe("tenantAdminDismissUnknownItem");
  });

  it("declares only the three Wave 1 operationIds (no smuggled Wave 2 operations)", () => {
    // Wave 2 link / create-new operations belong to a future GATED slice
    // (`005-WAVE2-CONTRACT`). This guards against accidentally landing
    // any of them in the Wave 1 contract.
    const declared = newContractOperations()
      .map(({ op }) => op.operationId)
      .filter((id): id is string => typeof id === "string")
      .sort();
    expect(declared).toEqual([...WAVE_1_OPERATION_IDS].sort());
  });

  it("does not collide with any operationId in the existing top-level contracts", () => {
    // Stop condition from the slice's execution-map entry:
    // "if the YAML edits any existing operationId".
    const collisions: string[] = [];
    for (const id of WAVE_1_OPERATION_IDS) {
      if (topLevelOperationIds.has(id)) {
        collisions.push(id);
      }
    }
    expect(collisions).toEqual([]);
  });
});

// ===========================================================================
// 3. Idempotency-Key alignment (T564 closeout — not Idempotency-Token)
// ===========================================================================
describe("posCaptureItem — Idempotency-Key header convention", () => {
  it("declares an Idempotency-Key header parameter on the capture operation", () => {
    const op = catalogDoc.paths?.[POS_CAPTURE_PATH]?.["post"];
    const headers = (op?.parameters ?? []).filter(
      (p) => p.in === "header",
    );
    const idempotencyHeader = headers.find(
      (p) => p.name === "Idempotency-Key",
    );
    expect(idempotencyHeader).toBeDefined();
    expect(idempotencyHeader?.required).toBe(true);
  });

  it("does NOT declare an Idempotency-Token header (drift guard per T564)", () => {
    // The spec.md / quickstart.md drafted `Idempotency-Token` but the
    // existing IdempotencyInterceptor on this repo uses `Idempotency-Key`
    // — see apps/api/src/idempotency/idempotency.interceptor.ts. The
    // contract MUST follow the implementation, not the spec drift.
    const op = catalogDoc.paths?.[POS_CAPTURE_PATH]?.["post"];
    const headerNames = (op?.parameters ?? [])
      .filter((p) => p.in === "header")
      .map((p) => p.name);
    expect(headerNames).not.toContain("Idempotency-Token");
  });

  it("declares x-idempotency: required on the capture operation", () => {
    // Matches the `createInvitation` precedent in memberships.openapi.yaml.
    const op = catalogDoc.paths?.[POS_CAPTURE_PATH]?.["post"] as
      | (OperationObject & { "x-idempotency"?: string })
      | undefined;
    expect(op?.["x-idempotency"]).toBe("required");
  });

  it("uses clerkJwt security for the POS capture operation (matches pos-shifts.openapi.yaml)", () => {
    const op = catalogDoc.paths?.[POS_CAPTURE_PATH]?.["post"];
    expect(op?.security).toContainEqual({ clerkJwt: [] });
  });
});

// ===========================================================================
// 4. Schema shape — closed envelopes for response safety
// ===========================================================================
describe("catalog/unknown-items.yaml — schema closedness", () => {
  it.each([
    "UnknownItem",
    "PosCaptureItemRequest",
    "PosCaptureResolvedResponse",
    "PosCaptureUnknownResponse",
    "ListUnknownItemsResponse",
    "Error",
  ])(
    "%s closes with additionalProperties: false (defence-in-depth response shape)",
    (schemaName) => {
      const schema = catalogDoc.components?.schemas?.[schemaName];
      expect(schema).toBeDefined();
      expect(schema?.["additionalProperties"]).toBe(false);
    },
  );

  it("UnknownItem.resolution_status is the closed enum {pending, resolved, dismissed}", () => {
    const schema = catalogDoc.components?.schemas?.["UnknownItem"];
    const props = schema?.["properties"] as
      | Record<string, { enum?: string[] }>
      | undefined;
    expect(props?.["resolution_status"]?.enum).toEqual([
      "pending",
      "resolved",
      "dismissed",
    ]);
  });

  it("UnknownItem.resolution_action is the closed enum {linked, created, dismissed}", () => {
    const schema = catalogDoc.components?.schemas?.["UnknownItem"];
    const props = schema?.["properties"] as
      | Record<string, { enum?: string[] }>
      | undefined;
    expect(props?.["resolution_action"]?.enum).toEqual([
      "linked",
      "created",
      "dismissed",
    ]);
  });

  it("Error envelope shape matches the outbox.openapi.yaml convention (error.code + error.message)", () => {
    const schema = catalogDoc.components?.schemas?.["Error"];
    const props = schema?.["properties"] as
      | { error?: { required?: string[] } }
      | undefined;
    expect(props?.error?.required).toEqual(
      expect.arrayContaining(["code", "message"]),
    );
  });
});
