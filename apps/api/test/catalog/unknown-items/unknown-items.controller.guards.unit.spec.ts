/**
 * unknown-items.controller.guards.unit.spec.ts — Docker-free fail-closed checks
 * for the dashboard/tenant-admin handlers' context guards.
 *
 * The Testcontainers integration suites always present a valid resolved context,
 * so the controller's authn guard branches (no context / null tenant / null
 * actor → 401) were never exercised. These in-process assertions prove every
 * protected handler fails closed before touching the service, independent of a
 * database — covering those guard branches deterministically.
 */
import { UnauthorizedException } from "@nestjs/common";

import { UnknownItemsController } from "../../../src/catalog/unknown-items/unknown-items.controller";
import type { TenantContextRequest } from "../../../src/context/types";

// The service is never reached on any of these paths (the guard throws first).
const controller = new UnknownItemsController({} as never);

const NO_CONTEXT = { context: undefined } as unknown as TenantContextRequest;
const NULL_TENANT = {
  context: { tenantId: null, storeId: null, userId: "u", isPlatformAdmin: false, source: "token" },
} as unknown as TenantContextRequest;
const NULL_ACTOR = {
  context: { tenantId: "t", storeId: null, userId: null, isPlatformAdmin: false, source: "token" },
} as unknown as TenantContextRequest;

describe("UnknownItemsController — context guards fail closed (unit)", () => {
  describe("list (tenant-wide / store-scoped read)", () => {
    it("no context → 401", async () => {
      await expect(
        controller.tenantAdminListUnknownItems(NO_CONTEXT, {} as never),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
    it("null tenant → 401", async () => {
      await expect(
        controller.tenantAdminListUnknownItems(NULL_TENANT, {} as never),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe("inspect (single-item read)", () => {
    it("no context → 401", async () => {
      await expect(
        controller.tenantAdminInspectUnknownItem(NO_CONTEXT, "id"),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
    it("null tenant → 401", async () => {
      await expect(
        controller.tenantAdminInspectUnknownItem(NULL_TENANT, "id"),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe("dismiss (single-item action)", () => {
    it("no context → 401", async () => {
      await expect(
        controller.tenantAdminDismissUnknownItem(NO_CONTEXT, "id"),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
    it("null tenant → 401", async () => {
      await expect(
        controller.tenantAdminDismissUnknownItem(NULL_TENANT, "id"),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
    it("null actor → 401", async () => {
      await expect(
        controller.tenantAdminDismissUnknownItem(NULL_ACTOR, "id"),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe("bulk-dismiss (batch action)", () => {
    it("no context → 401", async () => {
      await expect(
        controller.tenantAdminBulkDismissUnknownItems(NO_CONTEXT, { ids: [] } as never),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
    it("null tenant → 401", async () => {
      await expect(
        controller.tenantAdminBulkDismissUnknownItems(NULL_TENANT, { ids: [] } as never),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
    it("null actor → 401", async () => {
      await expect(
        controller.tenantAdminBulkDismissUnknownItems(NULL_ACTOR, { ids: [] } as never),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });
});
