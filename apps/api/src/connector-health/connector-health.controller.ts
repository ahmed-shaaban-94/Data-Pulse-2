/**
 * ConnectorHealth controllers — 020.
 *
 * TWO surfaces, TWO auth schemes, ONE service (data-model.md / contract):
 *
 *   1. ConnectorHealthHeartbeatController (US2, write) — the MACHINE surface.
 *      `@UseGuards(ConnectorAuthGuard)`: authenticates the opaque, revocable
 *      `connectorBearer`, enforces the full 018 usability predicate, and attaches
 *      `request.connector = { registrationId, tenantId, environment }`. Identity
 *      is taken from THAT context, NEVER the body (§XII). Returns HeartbeatAck.
 *
 *   2. ConnectorHealthReadController (US1/US3, read) — the HUMAN surface.
 *      `@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)` (class) +
 *      `@UseGuards(RolesGuard) @Roles("owner","tenant_admin")` (per route).
 *      SessionOnlyAdminGuard rejects ANY bearer (incl. dashboard_api) — human
 *      cookie session only (018 FR-005c). Default-deny; cross-tenant → safe 404.
 *
 * DP2 makes NO outbound ERPNext HTTP anywhere here (arc boundary).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";

import type { AuthedRequest } from "../auth/auth.guard";
import { ConnectorAuthGuard } from "../auth/connector-auth.guard";
import { Roles } from "../auth/roles.decorator";
import { RolesGuard } from "../auth/roles.guard";
import { SessionOnlyAdminGuard } from "../auth/session-only-admin.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { TenantContextGuard } from "../context/tenant-context.guard";
import type { TenantContextRequest } from "../context/types";
import { ConnectorHealthService } from "./connector-health.service";
import type { ConnectorHealthViewBody } from "./dto/connector-health-view.dto";
import {
  type HeartbeatAckBody,
  HeartbeatReportSchema,
  type HeartbeatReportDto,
} from "./dto/connector-heartbeat.dto";

// ---------------------------------------------------------------------------
// US2 — connector heartbeat (machine / connectorBearer)
// ---------------------------------------------------------------------------

@Controller("api/connector/v1/erpnext/health")
@UseGuards(ConnectorAuthGuard)
export class ConnectorHealthHeartbeatController {
  constructor(private readonly service: ConnectorHealthService) {}

  /** POST heartbeat — record liveness. Identity from the guard context (§XII). */
  @Post("heartbeat")
  @HttpCode(HttpStatus.OK)
  async heartbeat(
    @Req() request: AuthedRequest,
    @Body(new ZodValidationPipe(HeartbeatReportSchema))
    body: HeartbeatReportDto,
  ): Promise<HeartbeatAckBody> {
    const connector = request.connector;
    if (!connector) throw new UnauthorizedException("Unauthorized");
    // Identity STRICTLY from the 018 guard-attached context — never the body.
    return this.service.recordHeartbeat(
      { registrationId: connector.registrationId, tenantId: connector.tenantId },
      body,
    );
  }
}

// ---------------------------------------------------------------------------
// US1 / US3 — operator connection-status reads (human / cookieAuth, session-only)
// ---------------------------------------------------------------------------

@Controller("api/v1/connector/health")
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class ConnectorHealthReadController {
  constructor(private readonly service: ConnectorHealthService) {}

  private requireTenant(request: TenantContextRequest): string {
    const ctx = request.context;
    if (!ctx || ctx.tenantId === null) {
      throw new UnauthorizedException("Unauthorized");
    }
    return ctx.tenantId;
  }

  /** GET — list the tenant's connector connection status. */
  @Get()
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  async list(
    @Req() request: TenantContextRequest,
  ): Promise<{ items: ConnectorHealthViewBody[] }> {
    const tenantId = this.requireTenant(request);
    const items = await this.service.listHealth({ tenantId });
    return { items };
  }

  /** GET :registrationId — single-instance detail. Cross-tenant/absent → safe 404. */
  @Get(":registrationId")
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  async detail(
    @Req() request: TenantContextRequest,
    @Param("registrationId", new ZodValidationPipe(z.string().uuid()))
    registrationId: string,
  ): Promise<ConnectorHealthViewBody> {
    const tenantId = this.requireTenant(request);
    const view = await this.service.getHealth({ tenantId, registrationId });
    if (!view) throw new NotFoundException("Not Found");
    return view;
  }
}
