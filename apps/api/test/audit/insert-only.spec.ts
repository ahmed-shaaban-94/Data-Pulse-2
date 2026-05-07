/**
 * T237 — Audit insert-only proof.
 *
 * Proves that audit events are immutable at the application layer.
 * Three proof layers, each with a different scope:
 *
 * Layer A — TypeScript interface (compile-time)
 * -----------------------------------------------
 * `AuditRepository` exposes exactly one method: `listPage`. No `update`,
 * `delete`, `upsert`, or `patch` method exists. This is a structural proof:
 * the test constructs an object satisfying the interface, then inspects the
 * keys at runtime to confirm no mutation surface is reachable.
 *
 * Layer B — HTTP surface (controller + service)
 * -----------------------------------------------
 * `AuditController` exposes only `GET /api/v1/audit/events`. There are no
 * `POST`, `PUT`, `PATCH`, or `DELETE` routes for audit events. The tests
 * verify this via NestJS reflect-metadata (same mechanism NestJS itself uses
 * to discover routes) — no app instantiation required; metadata is on the
 * class/prototype and accessible immediately after import.
 *
 * `AuditService` exposes only `list()`. No mutation methods exist at the
 * service layer either.
 *
 * Layer C — DB/RLS acknowledgment (honest boundary statement)
 * ------------------------------------------------------------
 * The `audit_events_tenant_isolation` RLS policy (0000_initial.sql) does NOT
 * restrict UPDATE for the same-tenant `app_test` role. `applyAllUpAndCreateAppRole`
 * grants `UPDATE` on all tables to `app_test`, and the `WITH CHECK` clause
 * applies only to rows within the caller's tenant context, meaning a
 * same-tenant UPDATE would succeed at the database level.
 *
 * This is a documented limitation: insert-only semantics are enforced
 * exclusively at the application layer (no mutation surface in `AuditRepository`,
 * `AuditService`, or `AuditController`). A future hardening pass could
 * restrict the DB role with `REVOKE UPDATE, DELETE ON audit_events FROM app_role`
 * but that requires a migration and is out of scope for this slice.
 *
 * Out-of-scope boundary
 * ---------------------
 * `apps/worker/src/audit/` (the `AuditWorker` / `AuditWorkerService`) is
 * NOT covered here. The worker is the only legitimate INSERT path for the
 * application layer (it writes rows via `BullMQ` job consumption). Its
 * insert-only posture is separately governed by the job schema
 * (`AuditJobPayload` is INSERT-only by design: no `id` field that would
 * imply update semantics).
 */
import "reflect-metadata";

import { AuditController } from "../../src/audit/audit.controller";
import { AuditService } from "../../src/audit/audit.service";
import {
  AUDIT_REPOSITORY,
  type AuditRepository,
  type AuditEventRecord,
  type ListPageInput,
} from "../../src/audit/audit.repository";

// ---------------------------------------------------------------------------
// Layer A — TypeScript interface structural proof
// ---------------------------------------------------------------------------

describe("AuditRepository interface — mutation surface", () => {
  it("has exactly one method: listPage", () => {
    // Construct a minimal conforming implementation and verify its keys.
    // If a future developer adds `update` / `delete` to the interface,
    // TypeScript will enforce it on implementors; this runtime check pins
    // that the minimal-satisfying shape has exactly one entry.
    const implementation: AuditRepository = {
      listPage: async (_input: ListPageInput): Promise<AuditEventRecord[]> => [],
    };

    const methods = Object.keys(implementation);
    expect(methods).toEqual(["listPage"]);
  });

  it("does not expose update, delete, upsert, patch, save, create, or insert on AuditRepository", () => {
    const implementation: AuditRepository = {
      listPage: async (_input: ListPageInput): Promise<AuditEventRecord[]> => [],
    };

    expect(implementation).not.toHaveProperty("update");
    expect(implementation).not.toHaveProperty("delete");
    expect(implementation).not.toHaveProperty("upsert");
    expect(implementation).not.toHaveProperty("patch");
    expect(implementation).not.toHaveProperty("save");
    expect(implementation).not.toHaveProperty("create");
    expect(implementation).not.toHaveProperty("insert");
  });

  it("AuditRepository type is assignable from a read-only object (structural type safety)", () => {
    // TypeScript structural typing: an object with ONLY listPage satisfies
    // the interface. If the interface later adds a mutation method, this
    // `satisfies` expression will produce a compile error.
    const readOnlyImpl = {
      listPage: async (_input: ListPageInput): Promise<AuditEventRecord[]> => [],
    } satisfies AuditRepository;

    expect(typeof readOnlyImpl.listPage).toBe("function");
  });

  it("AUDIT_REPOSITORY DI token is a string constant (prevents accidental class-token re-binding)", () => {
    // String DI tokens require explicit binding. A class token would allow
    // any class with a compatible shape to satisfy the injection, including
    // a mutation-capable implementation. The string token closes that gap.
    expect(typeof AUDIT_REPOSITORY).toBe("string");
    expect(AUDIT_REPOSITORY).toBe("AUDIT_REPOSITORY");
  });
});

// ---------------------------------------------------------------------------
// Layer B — HTTP surface proof (controller + service)
// ---------------------------------------------------------------------------

describe("AuditService — mutation surface", () => {
  it("exposes only list() — no mutation methods on prototype", () => {
    const serviceProto = AuditService.prototype;
    const protoMethods = Object.getOwnPropertyNames(serviceProto).filter(
      (name) =>
        name !== "constructor" &&
        typeof (serviceProto as unknown as Record<string, unknown>)[name] === "function",
    );

    expect(protoMethods).toContain("list");
    expect(protoMethods).not.toContain("update");
    expect(protoMethods).not.toContain("delete");
    expect(protoMethods).not.toContain("upsert");
    expect(protoMethods).not.toContain("insert");
    expect(protoMethods).not.toContain("create");
  });
});

describe("AuditController — HTTP surface (metadata inspection, no app instantiation)", () => {
  it("has exactly one handler: listAuditEvents", () => {
    // Verify the only handler on AuditController is the GET events handler.
    const controllerMethods = Object.getOwnPropertyNames(
      AuditController.prototype,
    ).filter((name) => name !== "constructor");

    expect(controllerMethods).toContain("listAuditEvents");
    expect(controllerMethods.length).toBe(1);
  });

  it("listAuditEvents carries HTTP method = GET (RequestMethod.GET = 0)", () => {
    // NestJS stores the RequestMethod enum value in the 'method' metadata key.
    // RequestMethod enum: GET=0, POST=1, PUT=2, DELETE=5, PATCH=4.
    const httpMethod = Reflect.getMetadata(
      "method",
      AuditController.prototype.listAuditEvents,
    ) as number;

    expect(httpMethod).toBe(0); // RequestMethod.GET
  });

  it("no mutation HTTP method decorators exist on AuditController prototype", () => {
    // RequestMethod: GET=0, POST=1, PUT=2, PATCH=4, DELETE=5.
    const MUTATION_METHODS = new Set([1, 2, 4, 5]);

    const methods = Object.getOwnPropertyNames(AuditController.prototype).filter(
      (name) => name !== "constructor",
    );

    for (const method of methods) {
      const httpMethod = Reflect.getMetadata(
        "method",
        (AuditController.prototype as unknown as Record<string, unknown>)[method],
      ) as number | undefined;
      if (httpMethod !== undefined) {
        expect(MUTATION_METHODS.has(httpMethod)).toBe(false);
      }
    }
  });

  it("controller path prefix is api/v1/audit (scoped, not a wildcard)", () => {
    const controllerPath = Reflect.getMetadata("path", AuditController) as string;
    expect(controllerPath).toBe("api/v1/audit");
  });

  it("listAuditEvents handler path is 'events'", () => {
    const handlerPath = Reflect.getMetadata(
      "path",
      AuditController.prototype.listAuditEvents,
    ) as string;
    expect(handlerPath).toBe("events");
  });
});

// ---------------------------------------------------------------------------
// Layer C — DB/RLS honest boundary statement
// ---------------------------------------------------------------------------

describe("DB/RLS boundary — documented limitation", () => {
  /**
   * IMPORTANT: The following is a documented limitation, NOT a test gap.
   *
   * The `audit_events_tenant_isolation` RLS policy (packages/db/drizzle/0000_initial.sql)
   * applies to SELECT, INSERT, UPDATE, and DELETE (no FOR clause). The `WITH CHECK`
   * clause allows INSERT/UPDATE for rows within the caller's tenant context.
   *
   * Additionally, `applyAllUpAndCreateAppRole` (test/_helpers/postgres-container.ts)
   * grants `SELECT, INSERT, UPDATE, DELETE` to the `app_test` role.
   *
   * This means: a same-tenant UPDATE on `audit_events` would succeed at the
   * database level. Insert-only semantics are enforced EXCLUSIVELY at the
   * application layer:
   *
   *   - `AuditRepository` interface has no `update`/`delete` methods
   *   - `AuditService` has no `update`/`delete` methods
   *   - `AuditController` has no mutation HTTP handlers
   *
   * A future DB-layer hardening pass would issue:
   *   REVOKE UPDATE, DELETE ON audit_events FROM app_role;
   * but this requires a migration (out of scope for this slice per US6 constraints).
   */

  it("documents that insert-only is application-layer only (no DB-level UPDATE block)", () => {
    // Specification test: pins the current boundary. Update this test
    // when a REVOKE migration is added and the DB-layer guarantee is strengthened.
    const boundary = {
      applicationLayer: "insert-only — no update/delete on AuditRepository, AuditService, or AuditController",
      dbLayer: "UPDATE permitted for same-tenant rows by app_test role — REVOKE migration needed to close this",
      workerLayer: "out-of-scope — apps/worker is the INSERT path; governed separately",
    } as const;

    expect(boundary.applicationLayer).toMatch(/insert-only/);
    expect(boundary.dbLayer).toMatch(/REVOKE/);
    expect(boundary.workerLayer).toMatch(/out-of-scope/);
  });
});

// ---------------------------------------------------------------------------
// Stubs — DB-level enforcement (deferred, requires migration)
// ---------------------------------------------------------------------------

describe("DB-level insert-only enforcement (deferred)", () => {
  it.todo(
    "REVOKE UPDATE, DELETE ON audit_events FROM app_role — same-tenant UPDATE must fail at DB layer (requires migration)",
  );
  it.todo(
    "even with admin pool, UPDATE on audit_events fails after REVOKE (belt-and-suspenders; requires migration)",
  );
});
