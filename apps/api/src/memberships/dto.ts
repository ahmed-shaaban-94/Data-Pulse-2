import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MembershipUpdateSchema = z
  .object({
    role_code: z.string().min(1).optional(),
    store_access_kind: z.enum(["all", "specific"]).optional(),
    store_ids: z.array(z.string().regex(UUID_RE, "each store_id must be a UUID")).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    // At least one field required
    if (v.role_code === undefined && v.store_access_kind === undefined && v.store_ids === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one of role_code, store_access_kind, or store_ids must be provided",
      });
      return;
    }

    // store_access_kind="all" must not have store_ids
    if (v.store_access_kind === "all" && v.store_ids !== undefined && v.store_ids.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["store_ids"],
        message: "store_ids must be omitted or empty when store_access_kind is 'all'",
      });
    }

    // store_access_kind="specific" requires non-empty store_ids
    if (v.store_access_kind === "specific" && (v.store_ids === undefined || v.store_ids.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["store_ids"],
        message: "store_ids must be non-empty when store_access_kind is 'specific'",
      });
    }
  });

export type MembershipUpdateDto = z.infer<typeof MembershipUpdateSchema>;
