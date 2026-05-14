/**
 * T311 — AuditRetentionProcessor unit tests.
 *
 * Coverage
 * --------
 *  1. computeCutoff returns exactly 365 days before `now` (exact day math)
 *  2. A row with occurred_at = cutoff - 1 day is marked
 *  3. A row with occurred_at = cutoff + 1 day is NOT marked
 *  4. A row at exactly cutoff is NOT marked (predicate is strict <)
 *  5. An already-marked row (retentionMarkedAt !== null) is NOT re-marked
 *  6. Sweep correctly batches: 2500 rows older than cutoff → 3 batches (1000+1000+500)
 *  7. markedCount returned matches actual rows marked
 *  8. Idempotency: running the sweep twice with same clock → 0 marked on second run
 *  9. The repo interface exposes NO delete method (TypeScript structural check)
 * 10. Audit fact columns (id, occurredAt, action, etc.) remain untouched after sweep
 *
 * No BullMQ runtime, no Redis, no Postgres, no Docker.
 */
import {
  AuditRetentionProcessor,
  AUDIT_RETENTION_JOB_NAME,
  AUDIT_RETENTION_REPO,
  UnknownAuditRetentionJobError,
  MalformedAuditRetentionJobError,
  type AuditRetentionRepository,
} from "../../src/audit/audit-retention.processor";
import {
  computeCutoff,
  RETENTION_DAYS,
  BATCH_SIZE,
} from "../../src/audit/audit-retention.policy";

// ---------------------------------------------------------------------------
// In-memory row shape (mirrors the audit_events table's relevant columns)
// ---------------------------------------------------------------------------

interface FakeAuditRow {
  readonly id: string;
  readonly occurredAt: Date;
  readonly action: string;
  readonly tenantId: string | null;
  readonly metadata: Record<string, unknown>;
  retentionMarkedAt: Date | null;
}

// ---------------------------------------------------------------------------
// FakeAuditRetentionRepository
// ---------------------------------------------------------------------------

/**
 * Hand-rolled fake that holds an in-memory array of audit rows.
 *
 * `markBatch` mirrors the intended SQL:
 *   UPDATE audit_events
 *   SET retention_marked_at = markedAt
 *   WHERE occurred_at < cutoff
 *     AND retention_marked_at IS NULL
 *   LIMIT batchSize
 *
 * The fake updates at most `batchSize` rows per call and returns the count
 * actually marked, matching the processor's loop termination condition.
 *
 * There is NO delete method — this is intentional and tested in §9.
 */
class FakeAuditRetentionRepository implements AuditRetentionRepository {
  private rows: FakeAuditRow[];

  constructor(rows: FakeAuditRow[]) {
    this.rows = rows;
  }

  async markBatch(
    cutoff: Date,
    markedAt: Date,
    batchSize: number,
  ): Promise<number> {
    const eligible = this.rows.filter(
      (r) => r.occurredAt < cutoff && r.retentionMarkedAt === null,
    );
    const batch = eligible.slice(0, batchSize);
    for (const row of batch) {
      row.retentionMarkedAt = markedAt;
    }
    return batch.length;
  }

  /** Expose the backing store for assertions. Read-only access by reference. */
  getRows(): readonly FakeAuditRow[] {
    return this.rows;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fixed reference instant (mid-year, UTC noon). */
const FIXED_NOW = new Date("2026-05-14T12:00:00.000Z");

/**
 * Cutoff derived from FIXED_NOW: exactly 365 UTC days before.
 * Rows with occurred_at < this date are eligible.
 */
const EXPECTED_CUTOFF = computeCutoff(FIXED_NOW);

function makeRow(
  id: string,
  occurredAt: Date,
  retentionMarkedAt: Date | null = null,
): FakeAuditRow {
  return {
    id,
    occurredAt,
    action: "test.event",
    tenantId: "0b000000-0000-7000-8000-0000000b1001",
    metadata: { reason: "unit-test" },
    retentionMarkedAt,
  };
}

/** Build a processor backed by the given repo and a fixed clock. */
function makeProcessor(
  repo: AuditRetentionRepository,
  now: () => Date = () => FIXED_NOW,
): AuditRetentionProcessor {
  // Bypass NestJS DI — inject directly via constructor (Layer A pattern).
  return new AuditRetentionProcessor(repo, now);
}

// ---------------------------------------------------------------------------
// 1. computeCutoff — exact 365-day arithmetic
// ---------------------------------------------------------------------------

describe("computeCutoff — policy arithmetic", () => {
  it("returns a date exactly RETENTION_DAYS (365) before the reference now", () => {
    const referenceNow = new Date("2026-05-14T12:00:00.000Z");
    const cutoff = computeCutoff(referenceNow);
    const expectedMs = referenceNow.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    expect(cutoff.getTime()).toBe(expectedMs);
  });

  it("does not mutate the input date", () => {
    const input = new Date("2026-05-14T12:00:00.000Z");
    const inputTime = input.getTime();
    computeCutoff(input);
    expect(input.getTime()).toBe(inputTime);
  });
});

// ---------------------------------------------------------------------------
// 2. Row with occurred_at = cutoff - 1 day IS marked
// ---------------------------------------------------------------------------

describe("AuditRetentionProcessor — rows eligible for marking", () => {
  it("marks a row whose occurred_at is 1 day before the cutoff", async () => {
    const oneDayBeforeCutoff = new Date(EXPECTED_CUTOFF.getTime() - 24 * 60 * 60 * 1000);
    const row = makeRow("row-eligible-1", oneDayBeforeCutoff);
    const repo = new FakeAuditRetentionRepository([row]);
    const processor = makeProcessor(repo);

    await processor.process(AUDIT_RETENTION_JOB_NAME, {});

    expect(repo.getRows()[0]!.retentionMarkedAt).not.toBeNull();
    expect(repo.getRows()[0]!.retentionMarkedAt).toBeInstanceOf(Date);
  });

  it("sets retentionMarkedAt to the current sweep instant (the injected clock)", async () => {
    const oneDayBeforeCutoff = new Date(EXPECTED_CUTOFF.getTime() - 24 * 60 * 60 * 1000);
    const row = makeRow("row-eligible-clock", oneDayBeforeCutoff);
    const repo = new FakeAuditRetentionRepository([row]);
    const processor = makeProcessor(repo);

    await processor.process(AUDIT_RETENTION_JOB_NAME, {});

    expect(repo.getRows()[0]!.retentionMarkedAt!.getTime()).toBe(FIXED_NOW.getTime());
  });
});

// ---------------------------------------------------------------------------
// 3. Row with occurred_at = cutoff + 1 day is NOT marked
// ---------------------------------------------------------------------------

describe("AuditRetentionProcessor — rows NOT eligible (future of cutoff)", () => {
  it("does not mark a row whose occurred_at is 1 day after the cutoff", async () => {
    const oneDayAfterCutoff = new Date(EXPECTED_CUTOFF.getTime() + 24 * 60 * 60 * 1000);
    const row = makeRow("row-not-eligible-1", oneDayAfterCutoff);
    const repo = new FakeAuditRetentionRepository([row]);
    const processor = makeProcessor(repo);

    await processor.process(AUDIT_RETENTION_JOB_NAME, {});

    expect(repo.getRows()[0]!.retentionMarkedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. Row at exactly cutoff is NOT marked (strict < predicate)
// ---------------------------------------------------------------------------

describe("AuditRetentionProcessor — boundary predicate (strict <)", () => {
  it("does not mark a row whose occurred_at equals the cutoff exactly", async () => {
    const row = makeRow("row-boundary", EXPECTED_CUTOFF);
    const repo = new FakeAuditRetentionRepository([row]);
    const processor = makeProcessor(repo);

    await processor.process(AUDIT_RETENTION_JOB_NAME, {});

    expect(repo.getRows()[0]!.retentionMarkedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Already-marked rows are NOT re-marked
// ---------------------------------------------------------------------------

describe("AuditRetentionProcessor — already-marked rows", () => {
  it("does not overwrite retentionMarkedAt on rows already marked", async () => {
    const originalMarkedAt = new Date("2025-01-01T00:00:00.000Z");
    const oldRow = makeRow(
      "row-already-marked",
      new Date(EXPECTED_CUTOFF.getTime() - 48 * 60 * 60 * 1000),
      originalMarkedAt,
    );
    const repo = new FakeAuditRetentionRepository([oldRow]);
    const processor = makeProcessor(repo);

    await processor.process(AUDIT_RETENTION_JOB_NAME, {});

    // Should remain the original value, not overwritten with FIXED_NOW.
    expect(repo.getRows()[0]!.retentionMarkedAt!.getTime()).toBe(
      originalMarkedAt.getTime(),
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Sweep batches correctly: 2500 old rows → 3 batches (1000 + 1000 + 500)
// ---------------------------------------------------------------------------

describe("AuditRetentionProcessor — batching (2500 rows)", () => {
  it("processes 2500 eligible rows across 3 batches", async () => {
    // All 2500 rows are 366 days old — well past the cutoff.
    const oldDate = new Date(FIXED_NOW.getTime() - 366 * 24 * 60 * 60 * 1000);
    const rows: FakeAuditRow[] = Array.from({ length: 2500 }, (_, i) =>
      makeRow(`row-batch-${i}`, oldDate),
    );
    const repo = new FakeAuditRetentionRepository(rows);
    const processor = makeProcessor(repo);

    const result = await processor.process(AUDIT_RETENTION_JOB_NAME, {});

    expect(result.batchCount).toBe(3); // 1000 + 1000 + 500
    expect(result.markedCount).toBe(2500);
  });

  it(`uses BATCH_SIZE (${BATCH_SIZE}) per batch`, async () => {
    const oldDate = new Date(FIXED_NOW.getTime() - 366 * 24 * 60 * 60 * 1000);
    // Exactly BATCH_SIZE + 1 rows: forces 2 batches (BATCH_SIZE, then 1).
    const rows: FakeAuditRow[] = Array.from({ length: BATCH_SIZE + 1 }, (_, i) =>
      makeRow(`row-bsize-${i}`, oldDate),
    );
    const repo = new FakeAuditRetentionRepository(rows);
    const processor = makeProcessor(repo);

    const result = await processor.process(AUDIT_RETENTION_JOB_NAME, {});

    expect(result.batchCount).toBe(2);
    expect(result.markedCount).toBe(BATCH_SIZE + 1);
  });
});

// ---------------------------------------------------------------------------
// 7. markedCount returned matches actual rows marked
// ---------------------------------------------------------------------------

describe("AuditRetentionProcessor — markedCount accuracy", () => {
  it("reports markedCount equal to the number of rows actually marked", async () => {
    const oldDate = new Date(FIXED_NOW.getTime() - 400 * 24 * 60 * 60 * 1000);
    const rows: FakeAuditRow[] = Array.from({ length: 7 }, (_, i) =>
      makeRow(`row-count-${i}`, oldDate),
    );
    const repo = new FakeAuditRetentionRepository(rows);
    const processor = makeProcessor(repo);

    const result = await processor.process(AUDIT_RETENTION_JOB_NAME, {});

    const actuallyMarked = repo.getRows().filter((r) => r.retentionMarkedAt !== null).length;
    expect(result.markedCount).toBe(actuallyMarked);
    expect(result.markedCount).toBe(7);
  });

  it("reports markedCount = 0 when no rows are eligible", async () => {
    // All rows are recent (within retention window).
    const recentDate = new Date(FIXED_NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
    const rows: FakeAuditRow[] = Array.from({ length: 5 }, (_, i) =>
      makeRow(`row-recent-${i}`, recentDate),
    );
    const repo = new FakeAuditRetentionRepository(rows);
    const processor = makeProcessor(repo);

    const result = await processor.process(AUDIT_RETENTION_JOB_NAME, {});

    expect(result.markedCount).toBe(0);
    expect(result.batchCount).toBe(1); // one batch call that returns 0
  });
});

// ---------------------------------------------------------------------------
// 8. Idempotency: second run with same clock marks 0 rows
// ---------------------------------------------------------------------------

describe("AuditRetentionProcessor — idempotency", () => {
  it("marks 0 rows on a second run with the same clock (IS NULL predicate guard)", async () => {
    const oldDate = new Date(FIXED_NOW.getTime() - 400 * 24 * 60 * 60 * 1000);
    const rows: FakeAuditRow[] = Array.from({ length: 5 }, (_, i) =>
      makeRow(`row-idem-${i}`, oldDate),
    );
    const repo = new FakeAuditRetentionRepository(rows);
    const processor = makeProcessor(repo);

    const firstRun = await processor.process(AUDIT_RETENTION_JOB_NAME, {});
    expect(firstRun.markedCount).toBe(5);

    const secondRun = await processor.process(AUDIT_RETENTION_JOB_NAME, {});
    expect(secondRun.markedCount).toBe(0);
    expect(secondRun.batchCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 9. The AuditRetentionRepository interface has NO delete method
// ---------------------------------------------------------------------------

describe("AuditRetentionRepository interface", () => {
  it("exposes no deleteRows / purge / hardDelete method — audit rows must not be deleted", () => {
    const repo = new FakeAuditRetentionRepository([]);
    const asRecord = repo as unknown as Record<string, unknown>;

    expect(asRecord["deleteRows"]).toBeUndefined();
    expect(asRecord["purge"]).toBeUndefined();
    expect(asRecord["hardDelete"]).toBeUndefined();
    expect(asRecord["deleteAuditRows"]).toBeUndefined();
  });

  it("AUDIT_RETENTION_REPO token is a non-empty string", () => {
    expect(typeof AUDIT_RETENTION_REPO).toBe("string");
    expect(AUDIT_RETENTION_REPO.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 10. Audit fact columns remain untouched after sweep
// ---------------------------------------------------------------------------

describe("AuditRetentionProcessor — audit fact immutability", () => {
  it("does not modify any audit fact columns (id, occurredAt, action, tenantId, metadata)", async () => {
    const occurredAt = new Date(FIXED_NOW.getTime() - 400 * 24 * 60 * 60 * 1000);
    const originalRow = makeRow("row-fact-check", occurredAt);

    // Capture a deep copy of the fact fields before the sweep.
    const factsBefore = {
      id: originalRow.id,
      occurredAt: new Date(originalRow.occurredAt.getTime()),
      action: originalRow.action,
      tenantId: originalRow.tenantId,
      metadata: { ...originalRow.metadata },
    };

    const repo = new FakeAuditRetentionRepository([originalRow]);
    const processor = makeProcessor(repo);

    await processor.process(AUDIT_RETENTION_JOB_NAME, {});

    const rowAfter = repo.getRows()[0]!;

    // Fact columns must be identical to before.
    expect(rowAfter.id).toBe(factsBefore.id);
    expect(rowAfter.occurredAt.getTime()).toBe(factsBefore.occurredAt.getTime());
    expect(rowAfter.action).toBe(factsBefore.action);
    expect(rowAfter.tenantId).toBe(factsBefore.tenantId);
    expect(rowAfter.metadata).toEqual(factsBefore.metadata);

    // Only retentionMarkedAt should have changed.
    expect(rowAfter.retentionMarkedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Job name pin
// ---------------------------------------------------------------------------

describe("AUDIT_RETENTION_JOB_NAME", () => {
  it('equals "audit-retention-sweep"', () => {
    expect(AUDIT_RETENTION_JOB_NAME).toBe("audit-retention-sweep");
  });
});

// ---------------------------------------------------------------------------
// Unknown / malformed job name
// ---------------------------------------------------------------------------

describe("AuditRetentionProcessor — job name validation", () => {
  it("throws UnknownAuditRetentionJobError for an unrecognised job name", async () => {
    const repo = new FakeAuditRetentionRepository([]);
    const processor = makeProcessor(repo);

    await expect(
      processor.process("wrong-job-name", {}),
    ).rejects.toBeInstanceOf(UnknownAuditRetentionJobError);
  });

  it("error message includes the unrecognised job name", async () => {
    const repo = new FakeAuditRetentionRepository([]);
    const processor = makeProcessor(repo);

    await expect(
      processor.process("some-other-job", {}),
    ).rejects.toThrow("some-other-job");
  });

  it("rejects null payload — null is not an object, Zod parse fails", async () => {
    const repo = new FakeAuditRetentionRepository([]);
    const processor = makeProcessor(repo);

    await expect(
      processor.process(AUDIT_RETENTION_JOB_NAME, null),
    ).rejects.toBeInstanceOf(MalformedAuditRetentionJobError);
  });

  it("accepts empty object payload", async () => {
    const repo = new FakeAuditRetentionRepository([]);
    const processor = makeProcessor(repo);

    await expect(
      processor.process(AUDIT_RETENTION_JOB_NAME, {}),
    ).resolves.toBeDefined();
  });

  it("accepts payload with extra BullMQ metadata keys (passthrough)", async () => {
    const repo = new FakeAuditRetentionRepository([]);
    const processor = makeProcessor(repo);

    const richPayload = {
      timestamp: 1715515200000,
      repeatJobKey: "audit-retention-sweep::::86400000",
      correlationId: "018e4a1b-1234-7abc-8def-000000000099",
    };

    await expect(
      processor.process(AUDIT_RETENTION_JOB_NAME, richPayload),
    ).resolves.toBeDefined();
  });

  it("does not call markBatch on an unknown job name", async () => {
    const markBatch = jest.fn();
    const repo: AuditRetentionRepository = { markBatch };
    const processor = makeProcessor(repo);

    await expect(
      processor.process("wrong-job", {}),
    ).rejects.toThrow(UnknownAuditRetentionJobError);

    expect(markBatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DB error propagation
// ---------------------------------------------------------------------------

describe("AuditRetentionProcessor — DB error propagation", () => {
  it("propagates DB errors from markBatch unwrapped", async () => {
    const dbError = new Error("connection timeout");
    const repo: AuditRetentionRepository = {
      markBatch: jest.fn().mockRejectedValue(dbError),
    };
    const processor = makeProcessor(repo);

    await expect(
      processor.process(AUDIT_RETENTION_JOB_NAME, {}),
    ).rejects.toBe(dbError);
  });
});
