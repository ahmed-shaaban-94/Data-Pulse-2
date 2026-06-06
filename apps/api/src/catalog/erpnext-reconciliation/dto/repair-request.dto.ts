/**
 * repair-request.dto.ts — Zod body schemas for the 017 repair operations.
 *
 * Strict (`.strict()`, §XII): tenant + actor resolve from the dashboard session,
 * never the body. A posting repair carries only an optional operator `note`; a
 * stock repair carries `repairKind` (the action for the result's class) + `note`.
 */
import { z } from "zod";

export const RepairPostingBodySchema = z
  .object({
    note: z.string().max(1000).nullish(),
  })
  .strict();

export type RepairPostingBody = z.infer<typeof RepairPostingBodySchema>;

export const RepairStockBodySchema = z
  .object({
    repairKind: z.enum(["re_map", "re_sync"]),
    note: z.string().max(1000).nullish(),
  })
  .strict();

export type RepairStockBody = z.infer<typeof RepairStockBodySchema>;
