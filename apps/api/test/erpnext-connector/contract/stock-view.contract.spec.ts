/**
 * apps/api/test/erpnext-connector/contract/stock-view.contract.spec.ts
 *
 * Slice 019-CONTRACT — OpenAPI conformance test for
 * `packages/contracts/openapi/erpnext-connector/stock-view.yaml`.
 *
 * Mirrors `posting-feed.contract.spec.ts` (012):
 *
 *   * Loads the new contract via the production `loadOpenApiContracts` helper
 *     with an explicit `dir`, because the helper's directory scan is
 *     non-recursive (`apps/api/src/openapi/loader.ts`). The nested
 *     `erpnext-connector/` sub-directory is NOT picked up by the umbrella
 *     `loadOpenApiContracts()` call (R9 — explicit dir, else false GREEN).
 *
 *   * Asserts presence + global UNIQUENESS of the two 019 operationIds
 *     (`binViewPullRequests`, `binViewReportSnapshot`) against every shipped
 *     operationId (top-level + every nested sub-dir, since the umbrella loader
 *     is non-recursive).
 *
 *   * Verifies the 019 contract conventions per data-model.md §2-§3: OpenAPI 3.1;
 *     the `connectorBearer` MACHINE scheme (NOT POS `clerkJwt`); the
 *     pull/feed + snapshot-report bidirectional shape; exact-decimal `quantity`
 *     (string, never float); NO valuation/cost/price field anywhere (014 OQ-1);
 *     strict `additionalProperties: false`; REQUIRED `Idempotency-Key` on the
 *     report (§XI); the closed error set incl. `snapshot_required`; the
 *     non-disclosing Error envelope; the `runRef` correlation + `readAt`
 *     (connector) vs `recordedAt` (server) split (§X / US3).
 *
 * Structural / load-only (no app boot, no HTTP, no Docker). The DP2-side
 * runtime + the 017-rewire are future slices (FR-018, out of 019 scope).
 */
import "reflect-metadata";

import { resolve } from "node:path";

import { loadOpenApiContracts } from "../../../src/openapi/loader";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NEW_CONTRACT_ID = "stock-view";

const OPERATION_IDS = ["binViewPullRequests", "binViewReportSnapshot"] as const;

const PULL_PATH = "/api/connector/v1/erpnext/bin-view-requests";
const REPORT_PATH =
  "/api/connector/v1/erpnext/bin-view-requests/{requestRef}/snapshot";

function openapiSubDir(sub: string): string {
  // contract → erpnext-connector → test → api → apps → <repo root>
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
    sub,
  );
}

// ---------------------------------------------------------------------------
// Shared types — narrow; the loader returns `unknown` documents.
// ---------------------------------------------------------------------------

interface OperationObject {
  operationId?: string;
  security?: Array<Record<string, unknown>>;
  requestBody?: unknown;
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
    headers?: Record<string, Record<string, unknown>>;
  };
  security?: Array<Record<string, unknown>>;
  tags?: Array<{ name?: string }>;
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
  const connectorContracts = loadOpenApiContracts({
    dir: openapiSubDir("erpnext-connector"),
  });
  const newContract = connectorContracts.find((c) => c.id === NEW_CONTRACT_ID);
  if (!newContract) {
    const ids = connectorContracts.map((c) => c.id).join(", ");
    throw new Error(
      `${NEW_CONTRACT_ID} contract not found under ${openapiSubDir("erpnext-connector")}; loaded ids: [${ids}]`,
    );
  }
  doc = newContract.document as OpenApiDocument;

  // Global uniqueness guard: top-level + every nested sub-dir (loader is
  // non-recursive). Exclude the new contract itself (it shares the dir with
  // posting-feed, so re-scan and drop our own ids below).
  shippedOperationIds = new Set<string>();
  collectOperationIds(
    loadOpenApiContracts().map((c) => c.document as OpenApiDocument),
    shippedOperationIds,
  );
  for (const sub of [
    "catalog",
    "pos-sales",
    "inventory",
    "pos-payments",
    "connector",
    "erpnext-reconciliation",
  ]) {
    collectOperationIds(
      loadOpenApiContracts({ dir: openapiSubDir(sub) }).map(
        (c) => c.document as OpenApiDocument,
      ),
      shippedOperationIds,
    );
  }
  // erpnext-connector siblings EXCEPT stock-view itself (posting-feed's ids
  // are "shipped" and must not collide with ours).
  for (const c of connectorContracts) {
    if (c.id === NEW_CONTRACT_ID) continue;
    collectOperationIds([c.document as OpenApiDocument], shippedOperationIds);
  }
});

function operations(): Array<{
  path: string;
  method: string;
  op: OperationObject;
}> {
  const out: Array<{ path: string; method: string; op: OperationObject }> = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(item)) {
      out.push({ path, method, op });
    }
  }
  return out;
}

function findOp(operationId: string): OperationObject | undefined {
  return operations().find((o) => o.op.operationId === operationId)?.op;
}

// ===========================================================================
// 1. Loadability + document conventions
// ===========================================================================
describe("erpnext-connector/stock-view.yaml — loadability", () => {
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

  it("declares the connectorBearer MACHINE scheme — NOT the POS clerkJwt", () => {
    const schemes = doc.components?.securitySchemes ?? {};
    expect(schemes["connectorBearer"]).toBeDefined();
    expect(schemes["clerkJwt"]).toBeUndefined();
    const cb = schemes["connectorBearer"] as { type?: string; scheme?: string };
    expect(cb.type).toBe("http");
    expect(cb.scheme).toBe("bearer");
  });
});

// ===========================================================================
// 2. US1 — operations present, unique, machine-secured, bidirectional
// ===========================================================================
describe("stock-view.yaml — US1 operations", () => {
  it("declares exactly the two 019 operationIds", () => {
    const ids = operations()
      .map((o) => o.op.operationId)
      .filter((id): id is string => typeof id === "string")
      .sort();
    expect(ids).toEqual([...OPERATION_IDS].sort());
  });

  it("maps the pull to GET and the report to POST (bidirectional)", () => {
    expect(doc.paths?.[PULL_PATH]?.["get"]?.operationId).toBe(
      "binViewPullRequests",
    );
    expect(doc.paths?.[REPORT_PATH]?.["post"]?.operationId).toBe(
      "binViewReportSnapshot",
    );
  });

  it("does NOT collide with or rename any shipped operationId", () => {
    for (const id of OPERATION_IDS) {
      expect(shippedOperationIds.has(id)).toBe(false);
    }
  });

  it("uses the connector (machine) namespace, NOT the POS namespace", () => {
    for (const { path } of operations()) {
      expect(path.startsWith("/api/connector/v1/erpnext/")).toBe(true);
      expect(path.startsWith("/api/pos/")).toBe(false);
    }
  });

  it("secures every operation with connectorBearer (machine principal)", () => {
    for (const { op } of operations()) {
      expect(op.security).toContainEqual({ connectorBearer: [] });
      expect(op.security).not.toContainEqual({ clerkJwt: [] });
    }
  });
});

// ===========================================================================
// 3. US1 — pull feed page (mirrors 012 PostingFeedPage)
// ===========================================================================
describe("stock-view.yaml — US1 pull feed", () => {
  it("the pull accepts an OPTIONAL opaque `since` cursor + a bounded `limit`", () => {
    const params = findOp("binViewPullRequests")?.parameters ?? [];
    const since = params.find(
      (p) => p.name === "since" || p.$ref?.endsWith("/Since"),
    );
    expect(since).toBeDefined();
    const limit = params.find(
      (p) => p.name === "limit" || p.$ref?.endsWith("/Limit"),
    );
    expect(limit).toBeDefined();
  });

  it("the page carries items + advanced cursor + next_page_token", () => {
    const page = doc.components?.schemas?.["BinViewPage"];
    expect(page?.additionalProperties).toBe(false);
    expect(page?.properties).toHaveProperty("items");
    expect(page?.properties).toHaveProperty("cursor");
    expect(page?.required).toContain("cursor");
    expect(page?.properties).toHaveProperty("next_page_token");
    expect(page?.required).toContain("next_page_token");
  });

  it("the BinViewRequest feed item is strict + carries store/warehouse/run lineage + itemCursor, NO quantity", () => {
    const req = doc.components?.schemas?.["BinViewRequest"];
    expect(req?.additionalProperties).toBe(false);
    expect(req?.required).toEqual(
      expect.arrayContaining([
        "requestRef",
        "storeId",
        "erpnextWarehouseRef",
        "runRef",
        "itemCursor",
        "itemWindow",
      ]),
    );
    // The request carries NO bin data — quantity belongs to the report only.
    expect(req?.properties).not.toHaveProperty("quantity");
    expect(req?.properties).not.toHaveProperty("entries");
  });

  // HIGH fix (review cross-repo-fit): a warehouse has more SKUs than one report
  // can carry (report entries are capped ≤500). DP2 windows each warehouse into
  // ≤500-item BinViewRequests so each report maps cleanly to one ≤500-entry
  // snapshot — pagination lives on the REQUEST (which has a cursor), never on the
  // report body. The window bounds make the 500 entry cap a CORRECT invariant.
  it("BinViewRequest carries an itemWindow that bounds the request to ≤ the report ceiling", () => {
    const win = doc.components?.schemas?.["BinViewItemWindow"];
    expect(win?.additionalProperties).toBe(false);
    // The window declares an explicit maxItems matching the report ceiling (500),
    // so a request can never ask for more items than a report can return.
    expect(win?.required).toEqual(
      expect.arrayContaining(["windowSeq", "maxItems"]),
    );
    const maxItems = (win?.properties ?? {})["maxItems"] as {
      maximum?: number;
    };
    expect(maxItems?.maximum).toBe(500);
    // BinViewRequest.itemWindow references it.
    const ref = (doc.components?.schemas?.["BinViewRequest"]?.properties ?? {})[
      "itemWindow"
    ] as { $ref?: string };
    expect(ref?.$ref).toBe("#/components/schemas/BinViewItemWindow");
  });
});

// ===========================================================================
// 4. US1 — snapshot report body + BinEntry exact-decimal, NO valuation
// ===========================================================================
describe("stock-view.yaml — US1 snapshot report (O-1)", () => {
  it("the report REQUIRES the Idempotency-Key header (§XI)", () => {
    const params = findOp("binViewReportSnapshot")?.parameters ?? [];
    const key = params
      .map((p) => doc.components?.parameters?.[p.$ref?.split("/").pop() ?? ""])
      .find((k) => (k as { name?: string })?.name === "Idempotency-Key") as
      | { name?: string; in?: string; required?: boolean }
      | undefined;
    expect(key?.in).toBe("header");
    expect(key?.required).toBe(true);
  });

  it("the report binds requestRef as a PATH param (cannot be body-forged)", () => {
    const params = findOp("binViewReportSnapshot")?.parameters ?? [];
    const inline = params.find((p) => p.name === "requestRef" && p.in === "path");
    const viaRef = params
      .map((p) => doc.components?.parameters?.[p.$ref?.split("/").pop() ?? ""])
      .find(
        (rp) =>
          (rp as { name?: string; in?: string })?.name === "requestRef" &&
          (rp as { name?: string; in?: string })?.in === "path",
      );
    expect(inline ?? viaRef).toBeDefined();
  });

  it("the report carries a request body (write surface); the pull does not", () => {
    expect(findOp("binViewReportSnapshot")).toHaveProperty("requestBody");
    expect(findOp("binViewPullRequests")).not.toHaveProperty("requestBody");
  });

  it("BinViewSnapshotReport is strict: entries[] (minItems 0) + connector readAt, NO body scope", () => {
    const report = doc.components?.schemas?.["BinViewSnapshotReport"];
    expect(report?.additionalProperties).toBe(false);
    expect(report?.properties).toHaveProperty("entries");
    expect(report?.properties).toHaveProperty("readAt");
    // Scope is NEVER body-supplied (FR-005 §XII).
    const props = report?.properties ?? {};
    for (const leak of ["tenant_id", "tenantId", "storeId", "store_id"]) {
      expect(props).not.toHaveProperty(leak);
    }
  });

  it("BinEntry quantity is exact-decimal string (never float, exact pattern) + carries ErpnextItemRef + stockUom", () => {
    const entry = doc.components?.schemas?.["BinEntry"];
    expect(entry?.additionalProperties).toBe(false);
    // stockUom (review MEDIUM): the ERPNext Item.stock_uom, so 017 can detect a
    // unit mismatch instead of conflating it into a false quantity_divergence.
    expect(entry?.required?.sort()).toEqual(
      ["erpnextItemRef", "quantity", "stockUom"].sort(),
    );
    const qty = (entry?.properties ?? {})["quantity"] as {
      type?: string;
      pattern?: string;
    };
    expect(qty?.type).toBe("string");
    // Assert the EXACT pattern (review LOW): a regression to '.*' must fail.
    expect(qty?.pattern).toBe("^-?[0-9]{1,15}(\\.[0-9]{1,6})?$");
    const ref = (entry?.properties ?? {})["erpnextItemRef"] as { $ref?: string };
    expect(ref?.$ref).toBe("#/components/schemas/ErpnextItemRef");
    const uom = (entry?.properties ?? {})["stockUom"] as { type?: string };
    expect(uom?.type).toBe("string");
  });

  it("erpnextItemRef is generic {doctype:'Item', name} addressing (O-6)", () => {
    const itemRef = doc.components?.schemas?.["ErpnextItemRef"];
    expect(itemRef?.additionalProperties).toBe(false);
    expect(itemRef?.required?.sort()).toEqual(["doctype", "name"].sort());
    const props = itemRef?.properties ?? {};
    expect((props["doctype"] as { const?: string })?.const).toBe("Item");
    expect((props["name"] as { maxLength?: number })?.maxLength).toBe(140);
  });

  it("NO valuation / cost / price / amount field appears in ANY schema (014 OQ-1 / SC-004)", () => {
    const schemas = doc.components?.schemas ?? {};
    const banned = /^(cost|price|valuation|amount|value|rate|total|currency)/i;
    for (const [name, schema] of Object.entries(schemas)) {
      for (const prop of Object.keys(schema.properties ?? {})) {
        expect(`${name}.${prop}`).not.toMatch(
          new RegExp(`\\.(${banned.source.replace(/^\^|\$$/g, "")})`, "i"),
        );
      }
    }
  });
});

// ===========================================================================
// 5. US2 — non-disclosing isolation vocabulary
// ===========================================================================
describe("stock-view.yaml — US2 non-disclosure", () => {
  it("both operations declare 401 (Unauthorized) + 404 (NotFound) bound to canonical Error", () => {
    for (const id of OPERATION_IDS) {
      const responses = findOp(id)?.responses ?? {};
      expect(Object.keys(responses)).toEqual(
        expect.arrayContaining(["401", "404"]),
      );
    }
  });

  it("the Error envelope is { error: { code, message, request_id } } with NO details (non-disclosing)", () => {
    const errorSchema = doc.components?.schemas?.["Error"] as
      | {
          required?: string[];
          properties?: { error?: { properties?: Record<string, unknown> } };
        }
      | undefined;
    expect(errorSchema?.required).toContain("error");
    const inner = errorSchema?.properties?.error?.properties ?? {};
    expect(Object.keys(inner).sort()).toEqual(
      ["code", "message", "request_id"].sort(),
    );
    expect(inner).not.toHaveProperty("details");
  });

  it("declares the closed error-response set incl. snapshot_required", () => {
    const responses = doc.components?.responses ?? {};
    for (const name of [
      "ValidationFailure",
      "Unauthorized",
      "NotFound",
      "Conflict",
      "SnapshotRequired",
      "SystemFailure",
    ]) {
      expect(responses[name]).toBeDefined();
    }
  });
});

// ===========================================================================
// 6. US3 — run correlation, staleness, idempotent replay, clock split
// ===========================================================================
describe("stock-view.yaml — US3 correlation / staleness / idempotency", () => {
  it("maps the pull to 200/400/401/404/409/500 with 409 = snapshot_required", () => {
    const pull = doc.paths?.[PULL_PATH]?.["get"]?.responses ?? {};
    expect(Object.keys(pull)).toEqual(
      expect.arrayContaining(["200", "400", "401", "404", "409", "500"]),
    );
    const conflict = pull["409"] as { $ref?: string } | undefined;
    expect(conflict?.$ref).toBe("#/components/responses/SnapshotRequired");
  });

  it("maps the report to 200/201/400/401/404/409/500 with 409 = idempotency conflict", () => {
    const report = doc.paths?.[REPORT_PATH]?.["post"]?.responses ?? {};
    expect(Object.keys(report)).toEqual(
      expect.arrayContaining(["200", "201", "400", "401", "404", "409", "500"]),
    );
    const conflict = report["409"] as { $ref?: string } | undefined;
    expect(conflict?.$ref).toBe("#/components/responses/Conflict");
  });

  it("RecordedBinView carries run/warehouse correlation + BOTH the connector readAt (echoed) and the server recordedAt", () => {
    const rec = doc.components?.schemas?.["RecordedBinView"];
    expect(rec?.additionalProperties).toBe(false);
    // spec.md US3 acceptance scenario 2 (review MEDIUM): the recorded projection
    // MUST include the request/run correlation, the erpnextWarehouseRef, AND the
    // connector-reported read timestamp.
    expect(rec?.required).toEqual(
      expect.arrayContaining([
        "requestRef",
        "runRef",
        "erpnextWarehouseRef",
        "readAt",
        "recordedAt",
      ]),
    );
    // The §X clock split is preserved: BOTH clocks appear, as DISTINCT fields —
    // readAt = connector-reported (echoed from the report body), recordedAt =
    // DP2 server clock (the security clock). They are not the same field.
    expect(rec?.properties).toHaveProperty("readAt");
    expect(rec?.properties).toHaveProperty("recordedAt");
    const report = doc.components?.schemas?.["BinViewSnapshotReport"];
    expect(report?.properties).toHaveProperty("readAt");
    expect(report?.properties).not.toHaveProperty("recordedAt");
  });

  it("the report's 200 declares an Idempotent-Replayed response header", () => {
    const ok = (doc.paths?.[REPORT_PATH]?.["post"]?.responses ?? {})["200"] as
      | { headers?: Record<string, unknown> }
      | undefined;
    expect(ok?.headers ?? {}).toHaveProperty("Idempotent-Replayed");
  });
});

// ===========================================================================
// 7. Object-safety invariants (§XII / §IV) — no leaks
// ===========================================================================
describe("stock-view.yaml — object safety", () => {
  it("all payload schemas are strict (additionalProperties: false)", () => {
    const schemas = doc.components?.schemas ?? {};
    for (const name of [
      "BinViewRequest",
      "BinViewItemWindow",
      "BinViewPage",
      "BinViewSnapshotReport",
      "BinEntry",
      "ErpnextItemRef",
      "RecordedBinView",
    ]) {
      expect(schemas[name]?.additionalProperties).toBe(false);
    }
  });

  it("no schema leaks raw DB column / credential / tenant_id (§IV)", () => {
    const schemas = doc.components?.schemas ?? {};
    for (const schema of Object.values(schemas)) {
      const props = schema.properties ?? {};
      for (const leak of [
        "tenant_id",
        "tenantId",
        "created_by",
        "createdBy",
        "processed_at",
        "bypassrls",
      ]) {
        expect(props).not.toHaveProperty(leak);
      }
    }
  });
});
