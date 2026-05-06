/**
 * PosOperatorsController — Wave 1 sign-in / sign-out endpoints.
 *
 * Implements `POST /api/pos/v1/operators/sign-in` and
 * `POST /api/pos/v1/operators/sign-out` per
 * `packages/contracts/openapi/pos-operators.openapi.yaml`.
 *
 *   - Both endpoints carry the Clerk JWT as `Authorization: Bearer <jwt>`.
 *   - Bodies are validated by Zod (`PosOperatorSignInSchema` /
 *     `PosOperatorSignOutSchema`); malformed bodies are rejected by
 *     `ZodValidationPipe` and rendered as 400 by the global filter.
 *   - Sign-in success body is the discriminated union
 *     `{ kind: "signed_in", operator, operator_session }` or
 *     `{ kind: "takeover_required" }`.
 *   - Sign-out success body is exactly `{ kind: "signed_out" }` — no
 *     operator metadata, no session id, no timestamps. Sign-out is
 *     idempotent in *effect* but NOT in *response*: a session that is
 *     already revoked / expired / unknown / belongs to a different
 *     operator returns the uniform 401 envelope, never a second
 *     `signed_out`. That keeps the endpoint from being an existence
 *     oracle for `session_id` values (FR-POS-AUTH-6, ADR D10).
 *   - Every refusal returns the same generic 401 envelope; the actual
 *     cause is logged server-side keyed by `request_id` and is not
 *     enumerated in the response body.
 */
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

import { PosOperatorsService } from "./pos-operators.service";
import {
  PosOperatorSignInSchema,
  PosOperatorSignOutSchema,
  type PosOperatorSignInInput,
  type PosOperatorSignInResponseBody,
  type PosOperatorSignOutInput,
  type PosOperatorSignOutResponseBody,
} from "./dto";
import { ZodValidationPipe } from "../common/zod-validation.pipe";

const BEARER_PREFIX = "Bearer ";

@Controller("api/pos/v1/operators")
export class PosOperatorsController {
  constructor(private readonly service: PosOperatorsService) {}

  @Post("sign-in")
  @HttpCode(HttpStatus.OK)
  async signIn(
    @Headers("authorization") authorization: string | undefined,
    @Body(new ZodValidationPipe(PosOperatorSignInSchema))
    body: PosOperatorSignInInput,
    @Req() req: Request & { requestId?: string },
  ): Promise<PosOperatorSignInResponseBody> {
    const rawJwt = extractBearer(authorization);
    if (rawJwt === null) {
      // Missing / malformed authorization header — same generic 401 as
      // every other refusal cause (ADR D10). Cause is logged at the
      // service boundary; here the controller short-circuits.
      throw new UnauthorizedException("Unauthorized");
    }

    const requestId = req.requestId ?? "unknown";
    const result = await this.service.signIn(rawJwt, body, requestId);
    if (result.kind === "refused") {
      throw new UnauthorizedException("Unauthorized");
    }
    return result;
  }

  @Post("sign-out")
  @HttpCode(HttpStatus.OK)
  async signOut(
    @Headers("authorization") authorization: string | undefined,
    @Body(new ZodValidationPipe(PosOperatorSignOutSchema))
    body: PosOperatorSignOutInput,
    @Req() req: Request & { requestId?: string },
  ): Promise<PosOperatorSignOutResponseBody> {
    const rawJwt = extractBearer(authorization);
    if (rawJwt === null) {
      // Missing / malformed authorization header — same generic 401 as
      // every other refusal cause.
      throw new UnauthorizedException("Unauthorized");
    }

    const requestId = req.requestId ?? "unknown";
    const result = await this.service.signOut(rawJwt, body, requestId);
    if (result.kind === "refused") {
      throw new UnauthorizedException("Unauthorized");
    }
    return result;
  }
}

/**
 * Pull the bearer credential out of the `Authorization` header. Returns
 * the raw token on success, or null if the header is absent / not in
 * `Bearer <token>` form / has an empty token.
 *
 * Deliberately lenient about leading whitespace and case on the scheme:
 * `Authorization: bearer  <jwt>` is accepted. We reject only when the
 * scheme is missing or the token segment is empty.
 */
function extractBearer(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trimStart();
  if (trimmed.length < BEARER_PREFIX.length) return null;
  if (trimmed.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX.toLowerCase()) {
    return null;
  }
  const token = trimmed.slice(BEARER_PREFIX.length).trim();
  if (token.length === 0) return null;
  return token;
}
