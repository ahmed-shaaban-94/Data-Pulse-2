/**
 * T263 [US7] — POS namespace returns the standard not-found envelope.
 *
 * SC-8 requires that unknown routes under the reserved `/api/pos/v1/*`
 * namespace return the same error envelope shape as any other unknown route.
 * Three sub-paths are now live (`/operators`, `/audit-events`, `/shifts`);
 * this test targets paths that are NOT yet claimed to confirm the envelope
 * contract holds for the remaining unassigned namespace.
 *
 * Strategy — Docker-free:
 *   Build a minimal NestJS application that mounts only the
 *   `GlobalExceptionFilter`.  No controllers, no DB, no guards, no Redis.
 *   Any GET/POST to an unknown route triggers NestJS's built-in
 *   NotFoundException, which the filter converts to the shared envelope.
 *   This is the same envelope that a hypothetical future POS route would
 *   produce for an unknown sub-path before it is implemented.
 *
 * The test also probes a generic unknown route (`/api/v1/unknown`) as a
 * baseline so the assertion is comparative, not just structural.
 */
import "reflect-metadata";

import { type INestApplication, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { GlobalExceptionFilter } from "../../src/common/exception.filter";

// ---------------------------------------------------------------------------
// App bootstrap — zero controllers, just the global filter
// ---------------------------------------------------------------------------

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [],
    controllers: [],
    providers: [],
  }).compile();

  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
});

afterAll(async () => {
  await app.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectErrorEnvelope(body: unknown): void {
  // The shared envelope always has exactly { error: { code, message, request_id } }.
  expect(body).toMatchObject({
    error: {
      code: expect.any(String),
      message: expect.any(String),
      request_id: expect.any(String),
    },
  });
  expect(Object.keys(body as object)).toEqual(["error"]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POS namespace — not-found envelope (T263)", () => {
  it("GET /api/pos/v1/unknown returns 404 with standard error envelope", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/pos/v1/unknown")
      .expect(404);

    expectErrorEnvelope(res.body);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("POST /api/pos/v1/receipts (unclaimed sub-path) returns 404 with standard error envelope", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/pos/v1/receipts")
      .send({})
      .expect(404);

    expectErrorEnvelope(res.body);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("GET /api/v1/unknown (non-POS baseline) returns the same envelope shape", async () => {
    const res = await request(app.getHttpServer())
      .get("/api/v1/unknown")
      .expect(404);

    expectErrorEnvelope(res.body);
    const body = res.body as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("POS and generic not-found envelopes share identical top-level key sets", async () => {
    const [posRes, genericRes] = await Promise.all([
      request(app.getHttpServer()).get("/api/pos/v1/does-not-exist"),
      request(app.getHttpServer()).get("/completely-unknown-path"),
    ]);

    expectErrorEnvelope(posRes.body);
    expectErrorEnvelope(genericRes.body);

    // Both envelopes must carry the same structural keys inside `error`.
    const posKeys = Object.keys((posRes.body as { error: object }).error).sort();
    const genericKeys = Object.keys((genericRes.body as { error: object }).error).sort();
    expect(posKeys).toEqual(genericKeys);
  });
});
