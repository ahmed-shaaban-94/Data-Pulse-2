/**
 * PosAuditEventsController — Wave 2 audit-event sync endpoint.
 *
 * Implements `POST /api/pos/v1/audit-events` per
 * `packages/contracts/openapi/pos-audit-events.openapi.yaml`.
 *
 *   - The Clerk JWT (`Authorization: Bearer`) is OPTIONAL. Events emitted
 *     during sign-out, takeover confirmation, or mid-session account-disable
 *     paths may arrive without a current Clerk JWT.
 *   - When the header is present, the JWT MUST be valid (signature + exp +
 *     nbf + iss); fail-closed on JWKS error or signature mismatch.
 *   - Device authentication is via `device_token_attestation` in the body
 *     (Wave 1 body-based pattern). Invalid / revoked attestation → 401.
 *   - Every refusal returns the same generic 401 envelope. The actual cause
 *     is recorded server-side keyed by `request_id`.
 *   - Per-event validation failures are reported inline in the 200 `rejected`
 *     array, not as a 400.
 */
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

import { CLERK_VERIFIER, type ClerkVerifier } from "../pos-operators/clerk-verifier";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { PosAuditEventsService } from "./pos-audit-events.service";
import {
  PosAuditEventsSyncSchema,
  type PosAuditEventsSyncInput,
  type PosAuditEventsSyncResponseBody,
} from "./dto";

const BEARER_PREFIX = "Bearer ";

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

@Controller("api/pos/v1/audit-events")
export class PosAuditEventsController {
  constructor(
    private readonly service: PosAuditEventsService,
    @Inject(CLERK_VERIFIER) private readonly clerkVerifier: ClerkVerifier,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async syncBatch(
    @Headers("authorization") authorization: string | undefined,
    @Body(new ZodValidationPipe(PosAuditEventsSyncSchema))
    body: PosAuditEventsSyncInput,
    @Req() req: Request & { requestId?: string },
  ): Promise<PosAuditEventsSyncResponseBody> {
    // Clerk JWT is optional — verify only when present.
    if (authorization !== undefined) {
      const rawJwt = extractBearer(authorization);
      if (rawJwt === null) {
        throw new UnauthorizedException("Unauthorized");
      }
      try {
        await this.clerkVerifier.verify(rawJwt);
      } catch {
        throw new UnauthorizedException("Unauthorized");
      }
    }

    // request_id is uuid | null — never pass the string "unknown" to a uuid column.
    const requestId = req.requestId ?? null;
    const result = await this.service.syncBatch(body, requestId);
    if ("kind" in result && result.kind === "device_invalid") {
      throw new UnauthorizedException("Unauthorized");
    }
    return result as PosAuditEventsSyncResponseBody;
  }
}
