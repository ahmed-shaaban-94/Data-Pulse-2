/**
 * ContextController DTO schemas — slice 11 (T153).
 *
 * Conforms to `specs/001-foundation-auth-tenant-store/contracts/context.openapi.yaml`.
 * Bodies validated by `ZodValidationPipe`; bad bodies surface as
 * `ZodError` and the global exception filter renders them as a 400
 * `validation_error` envelope (consistent with AuthController).
 */
import { z } from "zod";

export const SwitchTenantSchema = z
  .object({
    tenant_id: z.string().uuid(),
  })
  .strict();
export type SwitchTenantInput = z.infer<typeof SwitchTenantSchema>;

export const SwitchStoreSchema = z
  .object({
    store_id: z.string().uuid(),
  })
  .strict();
export type SwitchStoreInput = z.infer<typeof SwitchStoreSchema>;
