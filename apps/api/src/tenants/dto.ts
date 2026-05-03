/**
 * TenantsController DTO schemas — slice 12 (T131).
 *
 * Conforms to `specs/001-foundation-auth-tenant-store/contracts/tenants.openapi.yaml`.
 * Bodies validated by `ZodValidationPipe`; bad bodies surface as
 * `ZodError` and the global exception filter renders them as 400
 * `validation_error` envelopes (consistent with AuthController and
 * ContextController).
 */
import { z } from "zod";

/**
 * Slug format mirrors the DB constraint `tenants_slug_format` exactly:
 *   ^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$
 *
 * Catching format errors here surfaces a 400 with a clear message
 * before any DB round-trip; the DB CHECK is the second line of
 * defense against direct-DB writes that bypass this layer.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,62}[a-z0-9]$/;

export const TenantCreateSchema = z
  .object({
    slug: z.string().regex(SLUG_RE),
    name: z.string().min(1),
  })
  .strict();
export type TenantCreateInput = z.infer<typeof TenantCreateSchema>;

/**
 * `PATCH /tenants/:id` accepts a partial body. Both fields are
 * optional, but at least one must be present (an empty PATCH is
 * a 400). The contract excludes `slug` from updates — slug is the
 * tenant's stable identifier in URLs once issued.
 */
export const TenantUpdateSchema = z
  .object({
    name: z.string().min(1).optional(),
    status: z.enum(["active", "suspended"]).optional(),
  })
  .strict()
  .refine(
    (v) => v.name !== undefined || v.status !== undefined,
    { message: "At least one of `name` or `status` must be provided." },
  );
export type TenantUpdateInput = z.infer<typeof TenantUpdateSchema>;
