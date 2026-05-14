import { Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import type { AuditRetentionRepository } from "./audit-retention.processor";

/**
 * CTE-based UPDATE: selects candidates in a deterministic order (occurred_at
 * ASC, id ASC) so repeated runs over the same data are stable, then marks
 * exactly batchSize rows per call.  Only retention_marked_at is written —
 * all audit fact columns remain untouched.
 */
const MARK_BATCH_SQL = `
WITH candidate AS (
  SELECT id
  FROM audit_events
  WHERE occurred_at < $1
    AND retention_marked_at IS NULL
  ORDER BY occurred_at ASC, id ASC
  LIMIT $3
)
UPDATE audit_events
SET retention_marked_at = $2
WHERE id IN (SELECT id FROM candidate)
RETURNING id
`;

@Injectable()
export class DrizzleAuditRetentionRepository implements AuditRetentionRepository {
  constructor(private readonly pool: Pool) {}

  async markBatch(cutoff: Date, markedAt: Date, batchSize: number): Promise<number> {
    const result = await this.pool.query<{ id: string }>(
      MARK_BATCH_SQL,
      [cutoff, markedAt, batchSize],
    );
    return result.rows.length;
  }
}

/**
 * No-op implementation for dev/test environments without DATABASE_URL.
 * Paired with NoOpWorkerFactory — no jobs flow on this path.
 */
@Injectable()
export class NoOpAuditRetentionRepository implements AuditRetentionRepository {
  async markBatch(_cutoff: Date, _markedAt: Date, _batchSize: number): Promise<number> {
    return 0;
  }
}
