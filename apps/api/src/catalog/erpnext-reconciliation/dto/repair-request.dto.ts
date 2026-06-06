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

/** Trigger a stock reconciliation run — strict; only the target store. */
export const TriggerRunBodySchema = z
  .object({
    storeId: z.string().uuid(),
  })
  .strict();

export type TriggerRunBody = z.infer<typeof TriggerRunBodySchema>;

/** List a run's results — cursor (uuid), limit, optional class filter. */
export const ListResultsQuerySchema = z
  .object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    class: z.string().min(1).max(100).optional(),
  })
  .strict();

export type ListResultsQuery = z.infer<typeof ListResultsQuerySchema>;
