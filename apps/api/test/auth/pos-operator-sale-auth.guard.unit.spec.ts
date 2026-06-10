/**
 * pos-operator-sale-auth.guard.unit.spec.ts
 *
 * Docker-free unit coverage for PosOperatorSaleAuthGuard (008 Option Y).
 *
 * The sale routes authenticate the SAME way operator sign-in does: a verified
 * Clerk JWT in `Authorization: Bearer <jwt>` PLUS a `deviceTokenAttestation`
 * supplied in the request body. The guard runs the sign-in identity/eligibility
 * derivation (Clerk-verify → users.clerk_user_id=sub → device-by-attestation →
 * membership → role∈{owner,tenant_admin,store_manager} → store eligibility) and
 * publishes ResolvedContext onto `request.context` scoped FROM the device row +
 * membership — NEVER from the request body (FR-061 mass-assignment ban).
 *
 * Every failure mode collapses to the SAME generic UnauthorizedException (401):
 * no factor disclosure (NFR-003 analogue for the sale surface).
 *
 * Strategy: inject a fake OperatorContextResolver. No NestJS module, no
 * Testcontainers, no network. The resolver itself is unit-tested separately
 * against a real container in the capture suite.
 */
import "reflect-metadata";

import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";

import { PosOperatorSaleAuthGuard } from "../../src/auth/pos-operator-sale-auth.guard";
import type {
  OperatorContextResolver,
  ResolveOperatorResult,
} from "../../src/auth/operator-context-resolver";

const TENANT_ID = "0a000000-0000-7000-8000-0000000ten01";
const STORE_ID = "0a000000-0000-7000-8000-0000000sto01";
const USER_ID = "0a000000-0000-7000-8000-00000000aa01";

function makeCtx(req: object): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: <T>() => req as unknown as T }),
  } as unknown as ExecutionContext;
}

function makeRequest(opts: { bearer?: string; body?: unknown }): Record<string, unknown> {
  const req: Record<string, unknown> = { headers: {} as Record<string, string> };
  if (opts.bearer !== undefined) {
    (req.headers as Record<string, string>)["authorization"] = opts.bearer;
  }
  if (opts.body !== undefined) req.body = opts.body;
  return req;
}

function makeResolver(result: ResolveOperatorResult): {
  resolver: OperatorContextResolver;
  resolve: jest.Mock;
} {
  const resolve = jest.fn().mockResolvedValue(result);
  return { resolver: { resolve } as unknown as OperatorContextResolver, resolve };
}

const OK_RESULT: ResolveOperatorResult = {
  kind: "ok",
  context: {
    userId: USER_ID,
    tenantId: TENANT_ID,
    storeId: STORE_ID,
    isPlatformAdmin: false,
    source: "token",
  },
};

describe("PosOperatorSaleAuthGuard — happy path", () => {
  it("SALE1: valid Clerk JWT + body attestation → true and publishes req.context from the device/membership", async () => {
    const { resolver, resolve } = makeResolver(OK_RESULT);
    const guard = new PosOperatorSaleAuthGuard(resolver);

    const req = makeRequest({
      bearer: "Bearer clerk.jwt.value",
      body: { deviceTokenAttestation: "device-attestation-xyz" },
    });
    const ok = await guard.canActivate(makeCtx(req));

    expect(ok).toBe(true);
    expect(resolve).toHaveBeenCalledWith("clerk.jwt.value", "device-attestation-xyz");
    expect((req as { context?: unknown }).context).toEqual(OK_RESULT.context);
  });
});

describe("PosOperatorSaleAuthGuard — refusals collapse to 401", () => {
  it("SALE2: missing Authorization header → 401, resolver not called", async () => {
    const { resolver, resolve } = makeResolver(OK_RESULT);
    const guard = new PosOperatorSaleAuthGuard(resolver);

    const req = makeRequest({ body: { deviceTokenAttestation: "x" } });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("SALE3: non-Bearer scheme → 401", async () => {
    const { resolver } = makeResolver(OK_RESULT);
    const guard = new PosOperatorSaleAuthGuard(resolver);

    const req = makeRequest({ bearer: "Basic abc", body: { deviceTokenAttestation: "x" } });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("SALE4: missing body attestation → 401, resolver not called", async () => {
    const { resolver, resolve } = makeResolver(OK_RESULT);
    const guard = new PosOperatorSaleAuthGuard(resolver);

    const req = makeRequest({ bearer: "Bearer clerk.jwt", body: {} });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("SALE5: empty-string attestation → 401", async () => {
    const { resolver } = makeResolver(OK_RESULT);
    const guard = new PosOperatorSaleAuthGuard(resolver);

    const req = makeRequest({ bearer: "Bearer clerk.jwt", body: { deviceTokenAttestation: "" } });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("SALE6: resolver refuses (invalid jwt / unmapped / revoked device / ineligible role / store mismatch) → 401", async () => {
    const { resolver } = makeResolver({ kind: "refused", reason: "clerk_jwt_invalid" });
    const guard = new PosOperatorSaleAuthGuard(resolver);

    const req = makeRequest({
      bearer: "Bearer clerk.jwt",
      body: { deviceTokenAttestation: "device-attestation-xyz" },
    });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(UnauthorizedException);
    expect((req as { context?: unknown }).context).toBeUndefined();
  });

  it("SALE7: absent body object entirely → 401", async () => {
    const { resolver } = makeResolver(OK_RESULT);
    const guard = new PosOperatorSaleAuthGuard(resolver);

    const req = makeRequest({ bearer: "Bearer clerk.jwt" });
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
