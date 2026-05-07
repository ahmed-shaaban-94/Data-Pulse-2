/**
 * PosOperatorsController — Wave 1 sign-in/sign-out + Wave 3 roster/takeover/active-session.
 *
 * Implements the full `pos-operators.openapi.yaml` surface.
 *
 *   - All endpoints carry the Clerk JWT as `Authorization: Bearer <jwt>`.
 *   - Bodies are validated by Zod (strict schemas); malformed bodies are
 *     rejected by `ZodValidationPipe` and rendered as 400 by the global filter.
 *   - Every refusal returns the same generic 401 envelope; the actual cause is
 *     logged server-side keyed by `request_id` and is not enumerated in the
 *     response body.
 *   - Wave 3 GET endpoints (`roster`, `active-session`) gate via Clerk JWT
 *     only — no device attestation parameter is present in the GET schema.
 */
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

import { PosOperatorsService } from "./pos-operators.service";
import {
  PosActiveSessionQuerySchema,
  PosOperatorSignInSchema,
  PosOperatorSignOutSchema,
  PosRosterQuerySchema,
  PosTakeoverConfirmSchema,
  type PosActiveSessionQueryInput,
  type PosActiveSessionResponseBody,
  type PosOperatorSignInInput,
  type PosOperatorSignInResponseBody,
  type PosOperatorSignOutInput,
  type PosOperatorSignOutResponseBody,
  type PosRosterQueryInput,
  type PosRosterResponseBody,
  type PosTakeoverConfirmInput,
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
      throw new UnauthorizedException("Unauthorized");
    }

    const requestId = req.requestId ?? "unknown";
    const result = await this.service.signOut(rawJwt, body, requestId);
    if (result.kind === "refused") {
      throw new UnauthorizedException("Unauthorized");
    }
    return result;
  }

  @Get("roster")
  @HttpCode(HttpStatus.OK)
  async roster(
    @Headers("authorization") authorization: string | undefined,
    @Query(new ZodValidationPipe(PosRosterQuerySchema))
    query: PosRosterQueryInput,
    @Req() req: Request & { requestId?: string },
  ): Promise<PosRosterResponseBody> {
    const rawJwt = extractBearer(authorization);
    if (rawJwt === null) {
      throw new UnauthorizedException("Unauthorized");
    }

    const requestId = req.requestId ?? "unknown";
    const result = await this.service.roster(rawJwt, query, requestId);
    if (!("cashiers" in result)) {
      throw new UnauthorizedException("Unauthorized");
    }
    return result;
  }

  @Post("takeover/confirm")
  @HttpCode(HttpStatus.OK)
  async takeoverConfirm(
    @Headers("authorization") authorization: string | undefined,
    @Body(new ZodValidationPipe(PosTakeoverConfirmSchema))
    body: PosTakeoverConfirmInput,
    @Req() req: Request & { requestId?: string },
  ): Promise<PosOperatorSignInResponseBody> {
    const rawJwt = extractBearer(authorization);
    if (rawJwt === null) {
      throw new UnauthorizedException("Unauthorized");
    }

    const requestId = req.requestId ?? "unknown";
    const result = await this.service.takeoverConfirm(rawJwt, body, requestId);
    if (result.kind === "refused") {
      throw new UnauthorizedException("Unauthorized");
    }
    return result;
  }

  @Get("active-session")
  @HttpCode(HttpStatus.OK)
  async activeSession(
    @Headers("authorization") authorization: string | undefined,
    @Query(new ZodValidationPipe(PosActiveSessionQuerySchema))
    query: PosActiveSessionQueryInput,
    @Req() req: Request & { requestId?: string },
  ): Promise<PosActiveSessionResponseBody> {
    const rawJwt = extractBearer(authorization);
    if (rawJwt === null) {
      throw new UnauthorizedException("Unauthorized");
    }

    const requestId = req.requestId ?? "unknown";
    const result = await this.service.activeSession(rawJwt, query, requestId);
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
