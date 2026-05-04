/**
 * StoresController DTO schemas — slice US2 (T134).
 *
 * Conforms to `specs/001-foundation-auth-tenant-store/contracts/stores.openapi.yaml`.
 * Bodies validated by `ZodValidationPipe`; bad bodies surface as
 * `ZodError` and the global exception filter renders them as 400
 * `validation_error` envelopes.
 *
 * `.strict()` is load-bearing for FR-STORE-4 (no cross-tenant store
 * reassignment): an attacker submitting `{ tenant_id: "<other>" }` on
 * `PATCH /api/v1/stores/:store_id` is rejected at the validation layer
 * because the schema doesn't list `tenant_id` as a permitted key.
 * `tenant_id` is also not on the StoreCreate schema for the same
 * reason — store ownership comes from `request.context.tenantId`,
 * never the body.
 */
import { z } from "zod";

/**
 * `code` matches the contract: 1..64 chars. Uniqueness within a tenant
 * is enforced by the partial unique index `stores_tenant_code_uidx`
 * on `(tenant_id, lower(code)) WHERE deleted_at IS NULL`. The service
 * maps a `23505` on that constraint to a `ConflictException` (409).
 */
export const StoreCreateSchema = z
  .object({
    code: z.string().min(1).max(64),
    name: z.string().min(1),
  })
  .strict();
export type StoreCreateInput = z.infer<typeof StoreCreateSchema>;

/**
 * `PATCH /stores/:store_id` accepts a partial body. Both fields are
 * optional, but at least one must be present (an empty PATCH is a
 * 400). The contract excludes `code` from updates — same posture as
 * `tenants.slug`: store-code is the stable per-tenant identifier
 * once issued.
 *
 * `.strict()` rejects unknown keys → `tenant_id` (FR-STORE-4) and any
 * other extraneous field surface as 400.
 */
export const StoreUpdateSchema = z
  .object({
    name: z.string().min(1).optional(),
    is_active: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) => v.name !== undefined || v.is_active !== undefined,
    { message: "At least one of `name` or `is_active` must be provided." },
  );
export type StoreUpdateInput = z.infer<typeof StoreUpdateSchema>;
