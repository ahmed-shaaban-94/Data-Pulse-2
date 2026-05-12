import { Module } from "@nestjs/common";
import { createLogger, type Logger } from "@data-pulse-2/shared";
import type { Pool } from "pg";

import { AuthModule, PG_POOL } from "../auth/auth.module";
import {
  CLERK_VERIFIER,
  type ClerkVerifier,
  clerkVerifierFactory,
} from "../pos-operators/clerk-verifier";
import { PosShiftsController } from "./pos-shifts.controller";
import { PosShiftsService } from "./pos-shifts.service";

export const POS_SHIFTS_LOGGER = "POS_SHIFTS_LOGGER";

@Module({
  imports: [AuthModule],
  controllers: [PosShiftsController],
  providers: [
    {
      provide: CLERK_VERIFIER,
      useFactory: clerkVerifierFactory,
    },
    {
      provide: POS_SHIFTS_LOGGER,
      useFactory: (): Logger =>
        createLogger({
          service: "api.pos-shifts",
          level: process.env["LOG_LEVEL"] ?? "info",
        }),
    },
    {
      provide: PosShiftsService,
      useFactory: (pool: Pool, verifier: ClerkVerifier, logger: Logger): PosShiftsService =>
        new PosShiftsService(pool, verifier, logger),
      inject: [PG_POOL, CLERK_VERIFIER, POS_SHIFTS_LOGGER],
    },
  ],
})
export class PosShiftsModule {}
