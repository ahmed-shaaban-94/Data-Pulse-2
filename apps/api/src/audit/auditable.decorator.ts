import { SetMetadata, type CustomDecorator } from "@nestjs/common";

/**
 * Metadata key used by `AuditEmitterInterceptor` to discover auditable
 * routes. Namespaced to avoid collision with third-party libraries.
 */
export const AUDITABLE_KEY = "dp2:auditable";

/**
 * `@Auditable(action)` — marks a route handler as auditable.
 *
 * The interceptor reads this metadata via `Reflector` and emits one
 * `AuditJobPayload` per request. Routes without this decorator are
 * transparent to the interceptor (no-op fast path).
 *
 * Usage:
 *   @Auditable("context.switch.tenant")
 *   @Post("tenant")
 *   async switchTenant(...) { ... }
 *
 * Action naming convention: `<domain>.<verb>.<detail>` in dot notation,
 * matching the `AuditEvent.action` field in the OpenAPI contract
 * (`specs/001-foundation-auth-tenant-store/contracts/audit.openapi.yaml`).
 *
 * This decorator is passive — it only publishes metadata. No-op on its
 * own; the interceptor drives all side effects.
 */
export const Auditable = (action: string): CustomDecorator =>
  SetMetadata(AUDITABLE_KEY, action);
