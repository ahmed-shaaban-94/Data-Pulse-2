/**
 * ConnectorHealthModule — 020-SETUP (T001).
 *
 * The DP2 connector health / connection-status surface (feature 020): a
 * registered connector instance (018 `connector_registration`) reports liveness
 * via a heartbeat (machine `connectorBearer`), and a tenant admin reads the
 * derived connection status (human `cookieAuth`, the 018 session-only pattern).
 *
 * Imports mirror the 018 ConnectorModule + the tenant-scoped admin siblings:
 *   - `AuthModule`    — provides `PG_POOL` + the guards (ConnectorAuthGuard,
 *                       SessionOnlyAdminGuard, RolesGuard).
 *   - `ContextModule` — `TenantContextGuard` (publishes `request.context`).
 *
 * NO AuditModule (FR-017: heartbeat writes no per-beat audit row; operator reads
 * ride standard request observability). NO worker module (v1 verdict is
 * read-derived; the scheduled stale-sweep is a named future follow-up).
 */
import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { ContextModule } from "../context/context.module";
import {
  ConnectorHealthHeartbeatController,
  ConnectorHealthReadController,
} from "./connector-health.controller";
import { ConnectorHealthService } from "./connector-health.service";

@Module({
  imports: [AuthModule, ContextModule],
  controllers: [ConnectorHealthHeartbeatController, ConnectorHealthReadController],
  providers: [ConnectorHealthService],
  exports: [ConnectorHealthService],
})
export class ConnectorHealthModule {}
