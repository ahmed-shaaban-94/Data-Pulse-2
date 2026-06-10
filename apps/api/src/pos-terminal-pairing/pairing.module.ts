/**
 * PairingModule — 027 POS Terminal-Pairing CONSUME.
 *
 * Owns the single unauthenticated bootstrap operation `posPairTerminal`
 * (POST /api/pos/v1/terminals/pair) + the `pairing_codes` store it reads. The
 * controller registers NO auth guard (the route is `security: []` per the
 * contract; DP-2 has no global APP_GUARD, so anonymity is the absence of a guard
 * — no other guard is weakened).
 *
 * Imports `AuthModule` for the `PG_POOL` provider + the auth-token primitives
 * (`generateRawToken`/`hashToken`, used in the repository). No AuditModule: the
 * success carries a SECRET and emits no audit payload (§VII). No ContextModule:
 * there is no caller tenant context to publish — the code row IS the source of
 * tenant context, resolved server-side in the repository.
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { PairingController } from "./pairing.controller";
import { PairingService } from "./pairing.service";

@Module({
  imports: [AuthModule],
  controllers: [PairingController],
  providers: [PairingService],
  exports: [PairingService],
})
export class PairingModule {}
