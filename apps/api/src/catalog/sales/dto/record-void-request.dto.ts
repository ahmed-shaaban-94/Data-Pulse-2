/**
 * record-void-request.dto.ts — 008 US3 (T053).
 *
 * Strict Zod schema for the `recordVoid` request body, mirroring
 * `RecordVoidRequest` in `packages/contracts/openapi/pos-sales/sales.yaml`.
 *
 * `.strict()` enforces the FR-061 mass-assignment ban: `voidedAt` / tenant /
 * store / actor resolve server-side and are NOT accepted from the body. The
 * void's own `(sourceSystem, externalId)` pair is recorded provenance + the
 * dedup key (FR-013), never body-assignable authority.
 */
import { z } from "zod";

export const RecordVoidRequestSchema = z
  .object({
    // 008 Option Y — device-token proof; consumed by the sale-auth guard,
    // never persisted by the service (see capture-sale-request.dto.ts).
    deviceTokenAttestation: z.string().min(1),
    sourceSystem: z.string().min(1).max(100),
    externalId: z.string().min(1).max(200),
  })
  .strict();

export type RecordVoidRequestDto = z.infer<typeof RecordVoidRequestSchema>;
