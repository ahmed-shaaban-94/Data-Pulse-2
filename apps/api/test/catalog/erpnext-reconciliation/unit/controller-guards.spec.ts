/**
 * 017-POLISH — controller guard + error-remap unit spec (Docker-free).
 *
 * Exercises the controller branches the integration specs don't hit directly: the
 * `requireContext`/`requireTenant` unauthorized throw (no session context), and
 * the NotFound/Store error-remap catch arms (a service error → the canonical
 * 404 envelope) + the non-mapped error re-throw. Pure unit — a stub service, no
 * DB, no app boot.
 */
import "reflect-metadata";

import {
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";

import { ErpnextReconciliationController } from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.controller";
import {
  RepairNotFoundError,
  RunNotFoundError,
  StoreNotFoundError,
  type ErpnextReconciliationService,
} from "../../../../src/catalog/erpnext-reconciliation/erpnext-reconciliation.service";
import type { TenantContextRequest } from "../../../../src/context/types";

const TENANT = "01900000-0000-7000-8000-0000000000a1";
const ACTOR = "01900000-0000-7000-8000-0000000000d1";
const REF = "01900000-0000-7000-8000-0000000000e1";

function reqWith(context: TenantContextRequest["context"]): TenantContextRequest {
  return { context } as TenantContextRequest;
}
const authedReq = reqWith({
  userId: ACTOR,
  tenantId: TENANT,
  storeId: null,
  isPlatformAdmin: false,
  source: "session",
});
const noCtxReq = reqWith(undefined);
const res = () => ({ setHeader: jest.fn(), status: jest.fn() }) as never;

function controllerWith(svc: Partial<ErpnextReconciliationService>): ErpnextReconciliationController {
  return new ErpnextReconciliationController(svc as ErpnextReconciliationService);
}

describe("017 controller — auth context guards", () => {
  it("listPostingBacklog with no session context → 401", async () => {
    const c = controllerWith({});
    await expect(
      c.listPostingBacklog(noCtxReq, { limit: 100 } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("repairPosting with no session context → 401", async () => {
    const c = controllerWith({});
    await expect(
      c.repairPosting(noCtxReq, REF, {} as never, res()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("triggerRun with no session context → 401", async () => {
    const c = controllerWith({});
    await expect(
      c.triggerRun(noCtxReq, { storeId: REF } as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe("017 controller — error remap → canonical 404", () => {
  it("repairPosting remaps RepairNotFoundError → NotFoundException(not_found)", async () => {
    const c = controllerWith({
      repairPosting: jest.fn().mockRejectedValue(new RepairNotFoundError()),
    });
    await expect(
      c.repairPosting(authedReq, REF, {} as never, res()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("triggerRun remaps StoreNotFoundError → NotFoundException(not_found)", async () => {
    const c = controllerWith({
      triggerRun: jest.fn().mockRejectedValue(new StoreNotFoundError()),
    });
    await expect(
      c.triggerRun(authedReq, { storeId: REF } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("getRun remaps RunNotFoundError → NotFoundException(not_found)", async () => {
    const c = controllerWith({
      getRun: jest.fn().mockRejectedValue(new RunNotFoundError()),
    });
    await expect(c.getRun(authedReq, REF)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("listResults remaps RunNotFoundError → NotFoundException(not_found)", async () => {
    const c = controllerWith({
      listResults: jest.fn().mockRejectedValue(new RunNotFoundError()),
    });
    await expect(
      c.listResults(authedReq, REF, { limit: 100 } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("repairStock remaps RunNotFoundError → NotFoundException(not_found)", async () => {
    const c = controllerWith({
      repairStock: jest.fn().mockRejectedValue(new RunNotFoundError()),
    });
    await expect(
      c.repairStock(authedReq, REF, REF, { repairKind: "re_sync" } as never, res()),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("re-throws a NON-mapped service error unchanged (not swallowed as 404)", async () => {
    const boom = new Error("unexpected");
    const c = controllerWith({
      repairPosting: jest.fn().mockRejectedValue(boom),
    });
    await expect(c.repairPosting(authedReq, REF, {} as never, res())).rejects.toBe(boom);
  });
});

describe("017 controller — replayed sets 200 + Idempotent-Replayed header", () => {
  it("repairPosting replayed=true → res.status(200) + header", async () => {
    const setHeader = jest.fn();
    const status = jest.fn();
    const c = controllerWith({
      repairPosting: jest.fn().mockResolvedValue({
        replayed: true,
        repair: {
          targetKind: "posting",
          targetRef: REF,
          repairKind: "re_post",
          outcome: "no_op_echo",
          resolvedDocumentRef: "DOC",
          recordedAt: "2026-06-06T00:00:00.000Z",
        },
      }),
    });
    await c.repairPosting(authedReq, REF, {} as never, { setHeader, status } as never);
    expect(setHeader).toHaveBeenCalledWith("Idempotent-Replayed", "true");
    expect(status).toHaveBeenCalledWith(200);
  });
});
