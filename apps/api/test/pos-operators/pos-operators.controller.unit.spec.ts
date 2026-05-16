/**
 * PosOperatorsController — unit spec (no Postgres, no Clerk network).
 *
 * Covers the `extractBearer` branches that are unreachable in the
 * Docker-based integration spec (pos-operators.controller.spec.ts):
 *
 *   - line 175: `if (trimmed.length < BEARER_PREFIX.length) return null`
 *     — triggered when the Authorization header is shorter than "Bearer ".
 *   - line 176: the wrong-scheme branch
 *     — triggered when the header doesn't start with "Bearer " (case-insensitive).
 *
 * Both map to a generic 401 via the `if (rawJwt === null) throw` at the top
 * of each controller action.
 */
import "reflect-metadata";

import { INestApplication, UnauthorizedException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { PosOperatorsController } from "../../src/pos-operators/pos-operators.controller";
import { PosOperatorsService } from "../../src/pos-operators/pos-operators.service";
import { GlobalExceptionFilter } from "../../src/common/exception.filter";

const SIGN_IN_BODY = {
  kind: "manager_admin",
  device_token_attestation: "attest-abc",
};

function makeMockService(): Partial<PosOperatorsService> {
  return {
    signIn: jest.fn().mockRejectedValue(new Error("should not reach service")),
    signOut: jest.fn().mockRejectedValue(new Error("should not reach service")),
    roster: jest.fn().mockRejectedValue(new Error("should not reach service")),
    takeoverConfirm: jest.fn().mockRejectedValue(new Error("should not reach service")),
    activeSession: jest.fn().mockRejectedValue(new Error("should not reach service")),
  };
}

let app: INestApplication;
let mockService: Partial<PosOperatorsService>;

beforeAll(async () => {
  mockService = makeMockService();

  const moduleRef = await Test.createTestingModule({
    controllers: [PosOperatorsController],
    providers: [
      { provide: PosOperatorsService, useValue: mockService },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new GlobalExceptionFilter());
  await app.init();
});

afterAll(async () => {
  await app.close();
});

describe("PosOperatorsController — extractBearer: Authorization too short", () => {
  it("returns 401 when Authorization header is shorter than 'Bearer '", async () => {
    // "Bear" is shorter than "Bearer " (7 chars) → extractBearer returns null
    // → controller throws UnauthorizedException before reaching the service.
    const res = await request(app.getHttpServer())
      .post("/api/pos/v1/operators/sign-in")
      .set("Authorization", "Bear")
      .send(SIGN_IN_BODY);

    expect(res.status).toBe(401);
    expect(mockService.signIn).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization header is empty string", async () => {
    const res = await request(app.getHttpServer())
      .post("/api/pos/v1/operators/sign-in")
      .set("Authorization", "")
      .send(SIGN_IN_BODY);

    expect(res.status).toBe(401);
    expect(mockService.signIn).not.toHaveBeenCalled();
  });
});

describe("PosOperatorsController — extractBearer: wrong scheme", () => {
  it("returns 401 when Authorization uses Basic scheme instead of Bearer", async () => {
    // "Basic abc123" doesn't start with "bearer " (case-insensitive)
    // → extractBearer returns null → 401.
    const res = await request(app.getHttpServer())
      .post("/api/pos/v1/operators/sign-in")
      .set("Authorization", "Basic abc123")
      .send(SIGN_IN_BODY);

    expect(res.status).toBe(401);
    expect(mockService.signIn).not.toHaveBeenCalled();
  });
});
