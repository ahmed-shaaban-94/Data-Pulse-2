/**
 * apps/api/test/outbox/admin.contract.spec.ts (T591, 1C-C1)
 *
 * Contract-conformance test for `listOutboxDeadLetters` +
 * `getOutboxDeadLetter`. Modelled after the audit slice in
 * `contract-conformance.spec.ts`:
 *
 *   * Loads `packages/contracts/openapi/outbox.openapi.yaml` via the
 *     production loader (`loadOpenApiContracts`).
 *   * Confirms both operationIds are registered AND paths match the
 *     controller's mounted routes (T300 conformance).
 *   * Boots a minimal Nest app with scripted guards and a fake service,
 *     issues real HTTP requests, validates response bodies against the
 *     compiled JSON Schema using ajv + ajv-formats (OpenAPI nullable
 *     pre-processed to JSON Schema 2019-09 `[T, "null"]`).
 *
 * NOTE: This spec does NOT modify the existing top-level
 * `contract-conformance.spec.ts` -- the loader auto-discovers the new
 * outbox.openapi.yaml; this spec is the per-endpoint behavioural
 * partner that the umbrella spec leaves to the slice author.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { DashboardAuthGuard } from "../../src/auth/dashboard-auth.guard";
import { RolesGuard } from "../../src/auth/roles.guard";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";
import { loadOpenApiContracts } from "../../src/openapi/loader";

import { OutboxAdminController } from "../../src/outbox/admin.controller";
import { OutboxAdminService } from "../../src/outbox/admin.service";
import type {
  ListOutboxDeadLettersResponse,
  OutboxDeadLetterDto,
} from "../../src/outbox/admin.dto";

// ---------------------------------------------------------------------------
// OpenAPI 3.0 `nullable` → JSON Schema rewrite (copied semantics from
// the umbrella contract-conformance spec — small enough to inline).
// ---------------------------------------------------------------------------
type JsonSchemaNode = { [key: string]: unknown };

function openapiSchemaToJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(openapiSchemaToJsonSchema);
  if (node === null || typeof node !== "object") return node;
  const obj = node as JsonSchemaNode;
  const result: JsonSchemaNode = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = openapiSchemaToJsonSchema(v);
  }
  if (result["nullable"] === true && typeof result["type"] === "string") {
    result["type"] = [result["type"] as string, "null"];
    delete result["nullable"];
  }
  if (result["nullable"] === true && typeof result["$ref"] === "string") {
    const ref = result["$ref"] as string;
    delete result["nullable"];
    delete result["$ref"];
    return { ...result, anyOf: [{ $ref: ref }, { type: "null" }] };
  }
  if (result["nullable"] === true) delete result["nullable"];
  return result;
}

// ---------------------------------------------------------------------------
// Build validators from the loaded contract.
// ---------------------------------------------------------------------------
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

let validateListResponse: ValidateFunction;
let validateDetailResponse: ValidateFunction;
let validateErrorResponse: ValidateFunction;

function buildValidators(): void {
  const contracts = loadOpenApiContracts();
  const outboxContract = contracts.find((c) => c.id === "outbox.openapi");
  if (!outboxContract) {
    throw new Error(
      "outbox.openapi contract not found — check packages/contracts/openapi/",
    );
  }

  const DOC_ID = "outbox.openapi";
  if (!ajv.getSchema(DOC_ID)) {
    const processedDoc = openapiSchemaToJsonSchema(
      outboxContract.document,
    ) as object;
    ajv.addSchema({ ...processedDoc, $id: DOC_ID });
  }

  validateListResponse = ajv.compile({
    $ref: `${DOC_ID}#/components/schemas/ListOutboxDeadLettersResponse`,
  });
  validateDetailResponse = ajv.compile({
    $ref: `${DOC_ID}#/components/schemas/OutboxDeadLetter`,
  });
  // The Error envelope is shared across 400/401/403/404 responses (see
  // outbox.openapi.yaml). We compile it once so the 404-conformance test
  // can assert the SHAPE of the error body, not just the status code.
  validateErrorResponse = ajv.compile({
    $ref: `${DOC_ID}#/components/schemas/Error`,
  });
}

function assertConformsTo(
  validator: ValidateFunction,
  body: unknown,
): void {
  const ok = validator(body);
  if (!ok) {
    throw new Error(
      `Response does not conform to schema:\n${JSON.stringify(validator.errors, null, 2)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Scripted guards + fake service (always-allow for conformance tests)
// ---------------------------------------------------------------------------
class AllowGuard implements CanActivate {
  canActivate(_ctx: ExecutionContext): boolean {
    return true;
  }
}

class FakeService {
  public listResponse: ListOutboxDeadLettersResponse = {
    items: [],
    next_cursor: null,
  };
  public detailResponse: OutboxDeadLetterDto | null = null;

  async list(): Promise<ListOutboxDeadLettersResponse> {
    return this.listResponse;
  }
  async get(): Promise<OutboxDeadLetterDto | null> {
    return this.detailResponse;
  }
}

function makeDto(overrides: Partial<OutboxDeadLetterDto> = {}): OutboxDeadLetterDto {
  return {
    event_id: "0195b100-0000-7000-8000-000000000001",
    event_type: "audit.event.created",
    tenant_id: "0195b100-0000-7000-8000-000000000010",
    store_id: null,
    delivery_state: "dead_lettered" as const,
    attempts: 8,
    correlation_id: "0195b100-0000-7000-8000-000000000099",
    last_error_class: "ConsumerTimeout",
    occurred_at: "2026-05-19T10:00:00.000Z",
    created_at: "2026-05-19T10:00:00.000Z",
    updated_at: "2026-05-19T11:30:00.000Z",
    processed_at: "2026-05-19T11:30:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
let app: INestApplication;
let fake: FakeService;

beforeAll(async () => {
  buildValidators();

  fake = new FakeService();

  const moduleRef = await Test.createTestingModule({
    controllers: [OutboxAdminController],
    providers: [{ provide: OutboxAdminService, useValue: fake }],
  })
    .overrideGuard(DashboardAuthGuard)
    .useValue(new AllowGuard())
    .overrideGuard(RolesGuard)
    .useValue(new AllowGuard())
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
}, 30_000);

afterAll(async () => {
  if (app) await app.close();
}, 30_000);

beforeEach(() => {
  fake.listResponse = { items: [], next_cursor: null };
  fake.detailResponse = null;
});

function http() {
  return request(app.getHttpServer());
}

// ===========================================================================
// 1. operationId presence + path mapping (T300 surface check)
// ===========================================================================
describe("OpenAPI surface — operationIds + paths (T300 surface)", () => {
  it("outbox.openapi.yaml registers listOutboxDeadLetters at GET /api/v1/admin/outbox/dead-letters", () => {
    const contracts = loadOpenApiContracts();
    const doc = (
      contracts.find((c) => c.id === "outbox.openapi")!.document as {
        paths: Record<string, Record<string, { operationId?: string }>>;
      }
    ).paths;
    expect(doc["/api/v1/admin/outbox/dead-letters"]).toBeDefined();
    expect(doc["/api/v1/admin/outbox/dead-letters"]!["get"]!.operationId).toBe(
      "listOutboxDeadLetters",
    );
  });

  it("outbox.openapi.yaml registers getOutboxDeadLetter at GET /api/v1/admin/outbox/dead-letters/{eventId}", () => {
    const contracts = loadOpenApiContracts();
    const doc = (
      contracts.find((c) => c.id === "outbox.openapi")!.document as {
        paths: Record<string, Record<string, { operationId?: string }>>;
      }
    ).paths;
    expect(
      doc["/api/v1/admin/outbox/dead-letters/{eventId}"],
    ).toBeDefined();
    expect(
      doc["/api/v1/admin/outbox/dead-letters/{eventId}"]!["get"]!.operationId,
    ).toBe("getOutboxDeadLetter");
  });

  it("contract.security uses cookieAuth at the document level (applies to BOTH endpoints)", () => {
    // CodeRabbit review on PR #240: assert the detail route is gated too.
    // Approach: rely on OpenAPI's top-level `security:` (which applies to
    // every operation unless an operation overrides it with its own
    // `security:` block). We assert:
    //   1. The `cookieAuth` securityScheme is defined.
    //   2. The document-level `security: [{ cookieAuth: [] }]` is present.
    //   3. Neither operation declares an empty `security: []` override
    //      (which would re-publish the endpoint as anonymous).
    const contracts = loadOpenApiContracts();
    const doc = contracts.find((c) => c.id === "outbox.openapi")!.document as {
      paths: Record<
        string,
        Record<string, { security?: Array<Record<string, unknown>> }>
      >;
      components: { securitySchemes: Record<string, unknown> };
      security?: Array<Record<string, unknown>>;
    };

    // 1. The cookieAuth scheme is defined.
    expect(doc.components.securitySchemes["cookieAuth"]).toBeDefined();

    // 2. Top-level document security includes cookieAuth. Order-agnostic
    //    so adding additional schemes later (e.g. bearerAuth for service
    //    accounts) does not silently invalidate this assertion.
    expect(doc.security).toBeDefined();
    expect(doc.security).toContainEqual({ cookieAuth: [] });

    // 3. Neither operation overrides with public security `[]` (which
    //    would make the endpoint anonymous-accessible). Per OpenAPI
    //    semantics, omitting per-operation `security` inherits from the
    //    document, so the assertion is "either inherited OR explicitly
    //    requires cookieAuth — never an empty override".
    const listOp = doc.paths["/api/v1/admin/outbox/dead-letters"]!["get"]!;
    const detailOp =
      doc.paths["/api/v1/admin/outbox/dead-letters/{eventId}"]!["get"]!;
    for (const [name, op] of [
      ["list", listOp] as const,
      ["detail", detailOp] as const,
    ]) {
      if (op.security !== undefined) {
        // If present, must be non-empty AND include cookieAuth.
        expect(op.security.length).toBeGreaterThan(0);
        expect(op.security).toContainEqual({ cookieAuth: [] });
        // Sanity: NEVER an empty-array override.
        expect(op.security).not.toEqual([]);
        // eslint-disable-next-line no-console
        void name;
      }
    }
  });

  it("OutboxDeadLetter schema forbids `payload` field (allowlist completeness)", () => {
    const contracts = loadOpenApiContracts();
    const doc = contracts.find((c) => c.id === "outbox.openapi")!.document as {
      components: {
        schemas: Record<
          string,
          {
            properties?: Record<string, unknown>;
            required?: string[];
            additionalProperties?: boolean;
          }
        >;
      };
    };
    const schema = doc.components.schemas["OutboxDeadLetter"]!;
    expect(schema.properties).toBeDefined();
    expect(Object.keys(schema.properties!)).not.toContain("payload");
    expect(Object.keys(schema.properties!)).not.toContain("last_error");
    // CodeRabbit review on PR #240: a property-list check alone does
    // NOT prevent a response from leaking `payload` or `last_error`
    // at runtime -- it only proves the documentation does not declare
    // them. The schema MUST be closed (`additionalProperties: false`)
    // for AJV to actually reject such responses. The negative cases
    // below verify the closed-schema contract end-to-end.
    expect(schema.additionalProperties).toBe(false);
  });

  it("AJV rejects an OutboxDeadLetter response that carries a `payload` field", () => {
    // Defence-in-depth probe: even if the repository or service
    // regressed and started widening the projection to include
    // `payload`, the AJV-compiled schema MUST reject the response.
    const valid = makeDto();
    const withPayload = { ...valid, payload: { leaked: true } };
    expect(validateDetailResponse(withPayload)).toBe(false);
  });

  it("AJV rejects an OutboxDeadLetter response that carries a raw `last_error` field", () => {
    // Mirror of the payload probe: the column-name-equal alias for the
    // sanitised error class MUST stay out of the response. Only the
    // documented `last_error_class` field is allowed.
    const valid = makeDto();
    const withRawError = {
      ...valid,
      last_error: "RuntimeError: connection refused",
    };
    expect(validateDetailResponse(withRawError)).toBe(false);
  });

  it("AJV rejects an OutboxDeadLetter response with an arbitrary unknown field", () => {
    // Generic closure probe: the schema must reject ANY field outside
    // the allowlist, not just the two named-sensitive ones above.
    const valid = makeDto();
    const withUnknown = { ...valid, debug_marker: "internal" };
    expect(validateDetailResponse(withUnknown)).toBe(false);
  });

  it("AJV accepts a properly-shaped OutboxDeadLetter (positive control)", () => {
    // Sanity check that the closure didn't accidentally break the
    // happy path -- the fixture DTO MUST still validate.
    expect(validateDetailResponse(makeDto())).toBe(true);
  });
});

// ===========================================================================
// 2. Behavioural conformance — list endpoint
// ===========================================================================
describe("GET /api/v1/admin/outbox/dead-letters — contract conformance", () => {
  it("empty page conforms to ListOutboxDeadLettersResponse", async () => {
    const res = await http()
      .get("/api/v1/admin/outbox/dead-letters")
      .expect(200);
    assertConformsTo(validateListResponse, res.body);
    expect(res.body).toEqual({ items: [], next_cursor: null });
  });

  it("one item with null processed_at boundary still conforms", async () => {
    fake.listResponse = {
      items: [makeDto({ processed_at: null, last_error_class: null, store_id: null, correlation_id: null })],
      next_cursor: null,
    };
    const res = await http()
      .get("/api/v1/admin/outbox/dead-letters")
      .expect(200);
    assertConformsTo(validateListResponse, res.body);
  });

  it("page with non-null next_cursor conforms", async () => {
    fake.listResponse = {
      items: [makeDto()],
      next_cursor: "dGVzdC1jdXJzb3I",
    };
    const res = await http()
      .get("/api/v1/admin/outbox/dead-letters")
      .expect(200);
    assertConformsTo(validateListResponse, res.body);
  });
});

// ===========================================================================
// 3. Behavioural conformance — detail endpoint
// ===========================================================================
describe("GET /api/v1/admin/outbox/dead-letters/{eventId} — contract conformance", () => {
  it("200 response body conforms to OutboxDeadLetter", async () => {
    const fixed = makeDto();
    fake.detailResponse = fixed;
    const res = await http()
      .get(`/api/v1/admin/outbox/dead-letters/${fixed.event_id}`)
      .expect(200);
    assertConformsTo(validateDetailResponse, res.body);
  });

  it("200 with all nullable fields null still conforms", async () => {
    const fixed = makeDto({
      store_id: null,
      correlation_id: null,
      last_error_class: null,
      processed_at: null,
    });
    fake.detailResponse = fixed;
    const res = await http()
      .get(`/api/v1/admin/outbox/dead-letters/${fixed.event_id}`)
      .expect(200);
    assertConformsTo(validateDetailResponse, res.body);
  });

  it("404 response body conforms to the documented Error envelope schema", async () => {
    // CodeRabbit review on PR #240: status-only assertion permits silent
    // drift in the error-body shape. Validate the 404 body against the
    // OpenAPI `Error` schema (`{ error: { code, message, request_id? } }`)
    // so a regression in `GlobalExceptionFilter` or the controller's
    // `NotFoundException` payload would surface here.
    fake.detailResponse = null;
    const res = await http()
      .get(
        "/api/v1/admin/outbox/dead-letters/0195b100-0000-7000-8000-000000000999",
      )
      .expect(404);
    assertConformsTo(validateErrorResponse, res.body);
    // Pin the canonical shape -- not an exhaustive assertion, just
    // enough to catch the most likely regressions (e.g. a return to
    // Nest's default flat `{statusCode, error, message}` shape).
    expect(res.body).toMatchObject({
      error: {
        code: expect.any(String) as unknown as string,
        message: expect.any(String) as unknown as string,
      },
    });
  });
});
