/**
 * context.controller.audit.spec.ts
 *
 * Metadata-only tests for @Auditable placement on ContextController.
 *
 * Verifies via `Reflect.getMetadata` that:
 *   - switchTenant carries AUDITABLE_KEY = "context.switch.tenant"
 *   - switchStore  carries AUDITABLE_KEY = "context.switch.store"
 *   - clearStore   carries AUDITABLE_KEY = "context.clear.store"
 *   - me (GET /context/me) is NOT decorated (no audit noise on reads)
 *
 * No HTTP server, no NestJS testing module, no BullMQ, no Redis needed.
 * Method names are verified against the actual controller source.
 */
import "reflect-metadata";
import { ContextController } from "../../src/context/context.controller";
import { AUDITABLE_KEY } from "../../src/audit/auditable.decorator";

describe("ContextController @Auditable metadata", () => {
  it("switchTenant is decorated with 'context.switch.tenant'", () => {
    const meta = Reflect.getMetadata(AUDITABLE_KEY, ContextController.prototype.switchTenant);
    expect(meta).toBe("context.switch.tenant");
  });

  it("switchStore is decorated with 'context.switch.store'", () => {
    const meta = Reflect.getMetadata(AUDITABLE_KEY, ContextController.prototype.switchStore);
    expect(meta).toBe("context.switch.store");
  });

  it("clearStore is decorated with 'context.clear.store'", () => {
    const meta = Reflect.getMetadata(AUDITABLE_KEY, ContextController.prototype.clearStore);
    expect(meta).toBe("context.clear.store");
  });

  it("me (GET /context/me) is NOT auditable", () => {
    const meta = Reflect.getMetadata(AUDITABLE_KEY, ContextController.prototype.me);
    expect(meta).toBeUndefined();
  });
});
