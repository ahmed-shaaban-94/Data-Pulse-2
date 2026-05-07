/**
 * contract-conformance.spec.ts — T300 thin slice 1.
 *
 * Strategy: build a minimal Nest app that mounts only `AuthController`,
 * with scripted doubles for every injectable dependency. Issue real HTTP
 * requests via Supertest so responses travel through real NestJS
 * serialization + GlobalExceptionFilter. Validate each response body
 * against the component schema from `packages/contracts/openapi/auth.openapi.yaml`
 * using ajv + ajv-formats.
 *
 * Thin slice 1 coverage:
 *   POST /api/v1/auth/signin  200 → SignInResponse
 *   POST /api/v1/auth/signin  401 → Error
 *
 * ajv notes:
 *   - strict: false — OpenAPI schemas contain `nullable`, `example`, etc.
 *     that are not valid JSON Schema keywords; strict mode would throw.
 *   - openapiSchemaToJsonSchema() — the contracts are authored with
 *     OpenAPI 3.0-style `nullable: true` under an `openapi: 3.1.0` header.
 *     ajv sees `type: string` and would reject a null value. The preprocessor
 *     rewrites `{ type: T, nullable: true }` → `{ type: [T, "null"] }` so
 *     the validator correctly accepts null where the contract allows it.
 */
import "reflect-metadata";

import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import cookieParser from "cookie-parser";
import {
  type CanActivate,
  type ExecutionContext,
  INestApplication,
  UnauthorizedException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AuthController } from "../src/auth/auth.controller";
import { AuthService } from "../src/auth/auth.service";
import { AuthGuard } from "../src/auth/auth.guard";
import { RateLimiter } from "../src/auth/rate-limit";
import type { SignInResult } from "../src/auth/dto";
import { ZodValidationPipe } from "../src/common/zod-validation.pipe";
import { GlobalExceptionFilter } from "../src/common/exception.filter";
import { loadOpenApiContracts } from "../src/openapi/loader";

// ---------------------------------------------------------------------------
// Schema loading + ajv setup
// ---------------------------------------------------------------------------

type JsonSchemaNode = { [key: string]: unknown };

/**
 * Recursively rewrites OpenAPI 3.0-style `{ type: T, nullable: true }` into
 * JSON Schema 2019-09 style `{ type: [T, "null"] }`. This is necessary because
 * the contracts use `nullable: true` for compatibility, but ajv 8 strictly
 * validates against JSON Schema semantics where `nullable` is unknown.
 */
function openapiSchemaToJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(openapiSchemaToJsonSchema);
  }
  if (node === null || typeof node !== "object") {
    return node;
  }

  const obj = node as JsonSchemaNode;
  const result: JsonSchemaNode = {};

  for (const [key, value] of Object.entries(obj)) {
    result[key] = openapiSchemaToJsonSchema(value);
  }

  if (
    result["nullable"] === true &&
    typeof result["type"] === "string"
  ) {
    result["type"] = [result["type"] as string, "null"];
    delete result["nullable"];
  }

  return result;
}

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

let validateSignInResponse: ValidateFunction;
let validateError: ValidateFunction;

/**
 * Build ajv validators for the SignInResponse and Error schemas.
 *
 * ajv resolves `$ref` pointers relative to the schema's `$id`. To make
 * `#/components/schemas/UserSummary` (and sibling refs) resolvable, we
 * add the entire auth document as a named schema. Each component schema is
 * then compiled by reference from that root document.
 */
function buildValidators(): void {
  const contracts = loadOpenApiContracts();
  const authContract = contracts.find((c) => c.id === "auth.openapi");
  if (!authContract) {
    throw new Error("auth.openapi contract not found — check packages/contracts/openapi/");
  }

  const doc = authContract.document as {
    components: { schemas: Record<string, unknown> };
  };
  const schemas = doc.components?.schemas;
  if (!schemas) {
    throw new Error("auth.openapi contract has no components.schemas");
  }

  if (!schemas["SignInResponse"]) throw new Error("SignInResponse schema not found in auth.openapi");
  if (!schemas["Error"]) throw new Error("Error schema not found in auth.openapi");

  // Add the full document as a named schema so that $ref resolution works.
  // All component schemas become reachable as #/components/schemas/<Name>.
  const processedDoc = openapiSchemaToJsonSchema(authContract.document) as object & { $id?: string };
  const DOC_ID = "auth.openapi";
  if (!ajv.getSchema(DOC_ID)) {
    ajv.addSchema({ ...processedDoc, $id: DOC_ID });
  }

  // Build inline schemas that reference the named root document.
  validateSignInResponse = ajv.compile({
    $ref: `${DOC_ID}#/components/schemas/SignInResponse`,
  });
  validateError = ajv.compile({
    $ref: `${DOC_ID}#/components/schemas/Error`,
  });
}

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const FAKE_USER_ID = "0195b100-0000-7000-8000-000000000001";
const FAKE_SESSION_ID = "0195b100-0000-7000-8000-000000000002";

class FakeAuthService {
  public mode: "ok" | "bad-credentials" = "ok";

  async signIn(_email: string, _password: string): Promise<SignInResult> {
    if (this.mode === "bad-credentials") {
      throw new UnauthorizedException("Invalid credentials");
    }
    return {
      sessionId: FAKE_SESSION_ID,
      userId: FAKE_USER_ID,
      absoluteExpiresAt: new Date(Date.now() + 86_400_000),
      user: {
        id: FAKE_USER_ID,
        email: "test@example.com",
        display_name: null,
        is_platform_admin: false,
      },
    };
  }

  // Other methods called by the controller that are not exercised here
  async signOut(_sessionId: string): Promise<void> {}
  async refreshSession(_sessionId: string): Promise<void> {}
  async requestPasswordReset(_email: string): Promise<void> {}
  async confirmPasswordReset(_token: string, _newPassword: string): Promise<void> {}
  async requestEmailVerification(_userId: string): Promise<void> {}
  async confirmEmailVerification(_token: string): Promise<void> {}
}

class ScriptedAuthGuard implements CanActivate {
  public mode: "ok" | "reject" = "ok";

  canActivate(ctx: ExecutionContext): boolean {
    if (this.mode === "reject") {
      throw new UnauthorizedException("Unauthorized");
    }
    const req = ctx.switchToHttp().getRequest();
    req.principal = {
      kind: "session",
      sessionId: FAKE_SESSION_ID,
      userId: FAKE_USER_ID,
    };
    return true;
  }
}

/** No-op RateLimiter — always allows. */
class ScriptedRateLimiter {
  async check(): Promise<{ allowed: true; count: 1; remaining: 999; resetMs: 60000 }> {
    return { allowed: true, count: 1, remaining: 999, resetMs: 60_000 };
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let app: INestApplication;
let fakeAuth: FakeAuthService;
let authGuard: ScriptedAuthGuard;

beforeAll(async () => {
  buildValidators();

  fakeAuth = new FakeAuthService();
  authGuard = new ScriptedAuthGuard();
  const rateLimiter = new ScriptedRateLimiter();

  const moduleRef = await Test.createTestingModule({
    controllers: [AuthController],
    providers: [
      { provide: AuthService, useValue: fakeAuth },
      { provide: RateLimiter, useValue: rateLimiter },
    ],
  })
    .overrideGuard(AuthGuard)
    .useValue(authGuard)
    .compile();

  app = moduleRef.createNestApplication({ bufferLogs: true });
  app.use(cookieParser());
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
});

afterAll(async () => {
  if (app) await app.close();
});

beforeEach(() => {
  fakeAuth.mode = "ok";
  authGuard.mode = "ok";
});

function http() {
  return request(app.getHttpServer());
}

function assertConformsTo(validate: ValidateFunction, body: unknown): void {
  const valid = validate(body);
  if (!valid) {
    throw new Error(
      `Contract violation:\n${JSON.stringify(validate.errors, null, 2)}\n\nActual body:\n${JSON.stringify(body, null, 2)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/v1/auth/signin — contract conformance (T300)", () => {
  describe("200 SignInResponse", () => {
    it("response body conforms to SignInResponse schema", async () => {
      const res = await http()
        .post("/api/v1/auth/signin")
        .send({ email: "test@example.com", password: "correct-password" })
        .expect(200);

      assertConformsTo(validateSignInResponse, res.body);
    });

    it("200 body has user with nullable display_name accepted as null", async () => {
      const res = await http()
        .post("/api/v1/auth/signin")
        .send({ email: "test@example.com", password: "correct-password" })
        .expect(200);

      // Explicit shape check: display_name=null must not fail the validator
      expect(res.body.user.display_name).toBeNull();
      assertConformsTo(validateSignInResponse, res.body);
    });

    it("200 body has memberships array", async () => {
      const res = await http()
        .post("/api/v1/auth/signin")
        .send({ email: "test@example.com", password: "correct-password" })
        .expect(200);

      expect(Array.isArray(res.body.memberships)).toBe(true);
      assertConformsTo(validateSignInResponse, res.body);
    });

    it("200 body user.id is a valid UUID", async () => {
      const res = await http()
        .post("/api/v1/auth/signin")
        .send({ email: "test@example.com", password: "correct-password" })
        .expect(200);

      expect(typeof res.body.user.id).toBe("string");
      assertConformsTo(validateSignInResponse, res.body);
    });
  });

  describe("401 Error", () => {
    it("response body conforms to Error schema on bad credentials", async () => {
      fakeAuth.mode = "bad-credentials";

      const res = await http()
        .post("/api/v1/auth/signin")
        .send({ email: "test@example.com", password: "wrong-password" })
        .expect(401);

      assertConformsTo(validateError, res.body);
    });

    it("401 error envelope has required code and message fields", async () => {
      fakeAuth.mode = "bad-credentials";

      const res = await http()
        .post("/api/v1/auth/signin")
        .send({ email: "test@example.com", password: "wrong-password" })
        .expect(401);

      expect(res.body).toMatchObject({
        error: {
          code: expect.any(String),
          message: expect.any(String),
        },
      });
      assertConformsTo(validateError, res.body);
    });
  });
});
