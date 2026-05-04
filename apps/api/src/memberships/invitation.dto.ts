import { z } from "zod";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const InvitationCreateSchema = z
  .object({
    email: z.string().email().min(1),
    role_code: z.string().min(1),
    store_access_kind: z.enum(["all", "specific"]),
    store_ids: z
      .array(z.string().regex(UUID_RE, "each store_id must be a UUID"))
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.store_access_kind === "specific" && (!v.store_ids || v.store_ids.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["store_ids"],
        message: "store_ids must be non-empty when store_access_kind is 'specific'",
      });
    }
    if (v.store_access_kind === "all" && v.store_ids !== undefined && v.store_ids.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["store_ids"],
        message: "store_ids must be omitted or empty when store_access_kind is 'all'",
      });
    }
  });

export type InvitationCreateDto = z.infer<typeof InvitationCreateSchema>;
