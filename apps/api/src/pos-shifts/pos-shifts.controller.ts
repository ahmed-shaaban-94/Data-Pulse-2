import {
  Controller,
  Get,
  Headers,
  Query,
  Req,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";

import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { PosShiftsService } from "./pos-shifts.service";
import { StuckShiftsQuerySchema } from "./dto";

const BEARER_PREFIX = "bearer ";

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

@Controller("api/pos/v1/shifts")
export class PosShiftsController {
  constructor(private readonly posShiftsService: PosShiftsService) {}

  @Get("stuck")
  async getStuck(
    @Headers("authorization") authorization: string | undefined,
    @Query(new ZodValidationPipe(StuckShiftsQuerySchema)) query: { branch_id: string },
    @Req() req: Request & { requestId?: string },
  ) {
    const rawJwt = extractBearer(authorization);
    if (!rawJwt) {
      throw new UnauthorizedException("Unauthorized");
    }

    const requestId = req.requestId ?? null;
    const result = await this.posShiftsService.getStuck(rawJwt, query.branch_id, requestId);

    if (result.kind === "refused") {
      throw new UnauthorizedException("Unauthorized");
    }

    return result.body;
  }
}
