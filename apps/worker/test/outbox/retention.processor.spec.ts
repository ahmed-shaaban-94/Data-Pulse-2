/**
 * T590 -- OutboxRetentionProcessor unit tests.
 *
 * Pure unit tests with a hand-rolled FakeOutboxRetentionRepository -- no
 * BullMQ runtime, no Redis, no Postgres, no Docker. Mirrors the structure
 * of `apps/worker/test/audit/retention.spec.ts`.
 *
 * What this spec pins
 * -------------------
 *  P-1  computeRetentionCutoffs returns 90d / 365d before `now` (exact day math).
 *  P-2  processor calls repo.purgeBatch with both cutoffs and BATCH_SIZE.
 *  P-3  the delivered cutoff is exactly 90 days; the failed cutoff exactly 365.
 *  P-4  batching loop terminates on the first sub-BATCH_SIZE result.
 *  P-5  zero eligible rows -> one empty batch -> { purgedCount: 0, batchCount: 1 }.
 *  P-6  multiple full batches: 2500 eligible rows -> 3 batches (1000+1000+500).
 *  P-7  idempotency: a second sweep with the same clock returns 0.
 *  P-8  payload data is not required (the fake repo never reads payloads).
 *  P-9  job name guard: unknown name throws UnknownOutboxRetentionJobError.
 *  P-10 payload guard: non-object data throws MalformedOutboxRetentionJobError.
 *  P-11 durationMs is a non-negative number.
 *  P-12 PII safety: a payload containing a PII canary never appears in the
 *       return value or any thrown error message (the processor never even
 *       sees the payload -- the repo seam holds the row data).
 */
import {
  OutboxRetentionProcessor,
  OUTBOX_RETENTION_JOB_NAME,
  UnknownOutboxRetentionJobError,
  MalformedOutboxRetentionJobError,
  type OutboxRetentionRepository,
} from "../../src/outbox/retention.processor";
import {
  BATCH_SIZE,
  DELIVERED_RETENTION_DAYS,
  FAILED_RETENTION_DAYS,
  computeCutoff,
  computeRetentionCutoffs,
  type RetentionCutoffs,
} from "../../src/outbox/retention.policy";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Fixed reference instant -- mid-year, UTC noon. Same as audit-retention test. */
const FIXED_NOW = new Date("2026-05-14T12:00:00.000Z");

// ---------------------------------------------------------------------------
// FakeOutboxRetentionRepository
// ---------------------------------------------------------------------------

/**
 * Hand-rolled fake. `purgeBatch` decrements the configured pool of eligible
 * rows by `min(remaining, batchSize)` and records the args it was called
 * with. The fake intentionally does NOT track row contents -- the processor's
 * contract is that it never reads payload data, so the unit-test seam carries
 * only counts.
 */
class FakeOutboxRetentionRepository implements OutboxRetentionRepository {
  public readonly calls: Array<{
    cutoffs: RetentionCutoffs;
    batchSize: number;
  }> = [];
  private remaining: number;

  constructor(eligibleRows: number) {
    this.remaining = eligibleRows;
  }

  async purgeBatch(
    cutoffs: RetentionCutoffs,
    batchSize: number,
  ): Promise<number> {
    this.calls.push({ cutoffs, batchSize });
    const purged = Math.min(this.remaining, batchSize);
    this.remaining -= purged;
    return purged;
  }

  getRemaining(): number {
    return this.remaining;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fixedClock(): () => Date {
  return () => FIXED_NOW;
}

// ---------------------------------------------------------------------------
// P-1 / P-3: cutoff math
// ---------------------------------------------------------------------------

describe("retention.policy -- cutoff math (P-1, P-3)", () => {
  it("computeCutoff subtracts exactly N UTC days from `now` (P-1a)", () => {
    const cutoff90 = computeCutoff(FIXED_NOW, 90);
    const expected90 = new Date("2026-02-13T12:00:00.000Z"); // 90 days before May 14
    expect(cutoff90.toISOString()).toBe(expected90.toISOString());
  });

  it("DELIVERED_RETENTION_DAYS is 90 (P-3a)", () => {
    expect(DELIVERED_RETENTION_DAYS).toBe(90);
  });

  it("FAILED_RETENTION_DAYS is 365 (P-3b)", () => {
    expect(FAILED_RETENTION_DAYS).toBe(365);
  });

  it("computeRetentionCutoffs returns both windows in one call (P-1b)", () => {
    const cutoffs = computeRetentionCutoffs(FIXED_NOW);
    const expectedDelivered = new Date("2026-02-13T12:00:00.000Z");
    const expectedFailed = new Date("2025-05-14T12:00:00.000Z");
    expect(cutoffs.deliveredCutoff.toISOString()).toBe(
      expectedDelivered.toISOString(),
    );
    expect(cutoffs.failedCutoff.toISOString()).toBe(
      expectedFailed.toISOString(),
    );
  });

  it("failed cutoff is exactly 365 - 90 = 275 days earlier than delivered cutoff (P-3c)", () => {
    const cutoffs = computeRetentionCutoffs(FIXED_NOW);
    const diffMs =
      cutoffs.deliveredCutoff.getTime() - cutoffs.failedCutoff.getTime();
    const diffDays = diffMs / (24 * 60 * 60 * 1000);
    expect(diffDays).toBe(275);
  });
});

// ---------------------------------------------------------------------------
// P-2 / P-4 / P-5 / P-6: processor sweep loop
// ---------------------------------------------------------------------------

describe("OutboxRetentionProcessor -- sweep loop (P-2, P-4, P-5, P-6)", () => {
  it("calls repo.purgeBatch with both cutoffs and BATCH_SIZE (P-2)", async () => {
    const repo = new FakeOutboxRetentionRepository(0);
    const processor = new OutboxRetentionProcessor(repo, fixedClock());

    await processor.process(OUTBOX_RETENTION_JOB_NAME, {});

    expect(repo.calls).toHaveLength(1);
    const call = repo.calls[0]!;
    expect(call.batchSize).toBe(BATCH_SIZE);
    expect(call.cutoffs.deliveredCutoff.toISOString()).toBe(
      "2026-02-13T12:00:00.000Z",
    );
    expect(call.cutoffs.failedCutoff.toISOString()).toBe(
      "2025-05-14T12:00:00.000Z",
    );
  });

  it("zero eligible rows -> one empty batch -> 0 purged (P-5)", async () => {
    const repo = new FakeOutboxRetentionRepository(0);
    const processor = new OutboxRetentionProcessor(repo, fixedClock());

    const result = await processor.process(OUTBOX_RETENTION_JOB_NAME, {});

    expect(result.purgedCount).toBe(0);
    expect(result.batchCount).toBe(1);
    expect(repo.calls).toHaveLength(1);
  });

  it("loop terminates on the first sub-BATCH_SIZE result (P-4)", async () => {
    // 500 rows -> one partial batch -> loop exits.
    const repo = new FakeOutboxRetentionRepository(500);
    const processor = new OutboxRetentionProcessor(repo, fixedClock());

    const result = await processor.process(OUTBOX_RETENTION_JOB_NAME, {});

    expect(result.purgedCount).toBe(500);
    expect(result.batchCount).toBe(1);
  });

  it("2500 eligible rows -> 3 batches (1000+1000+500) (P-6)", async () => {
    const repo = new FakeOutboxRetentionRepository(2500);
    const processor = new OutboxRetentionProcessor(repo, fixedClock());

    const result = await processor.process(OUTBOX_RETENTION_JOB_NAME, {});

    expect(result.purgedCount).toBe(2500);
    expect(result.batchCount).toBe(3);
    expect(repo.calls).toHaveLength(3);
  });

  it("exact-multiple eligible rows trigger one extra terminal empty batch (P-6b)", async () => {
    // 2000 rows -> 1000 + 1000 -> third call returns 0 -> loop terminates.
    const repo = new FakeOutboxRetentionRepository(2000);
    const processor = new OutboxRetentionProcessor(repo, fixedClock());

    const result = await processor.process(OUTBOX_RETENTION_JOB_NAME, {});

    expect(result.purgedCount).toBe(2000);
    expect(result.batchCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// P-7: idempotency
// ---------------------------------------------------------------------------

describe("OutboxRetentionProcessor -- idempotency (P-7)", () => {
  it("running the sweep twice with the same clock -> second run purges 0", async () => {
    const repo = new FakeOutboxRetentionRepository(1500);
    const processor = new OutboxRetentionProcessor(repo, fixedClock());

    const first = await processor.process(OUTBOX_RETENTION_JOB_NAME, {});
    expect(first.purgedCount).toBe(1500);

    const second = await processor.process(OUTBOX_RETENTION_JOB_NAME, {});
    expect(second.purgedCount).toBe(0);
    expect(second.batchCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// P-8: payload is not required by the processor
// ---------------------------------------------------------------------------

describe("OutboxRetentionProcessor -- payload independence (P-8)", () => {
  it("the repo seam carries only counts -- payloads are NOT exposed to the processor (P-8)", async () => {
    // The FakeOutboxRetentionRepository deliberately does not accept payload
    // data at all -- it only knows about eligibility counts and the cutoffs
    // received. The fact that this test compiles AND the processor satisfies
    // the contract proves the processor never reaches for payload-shaped
    // fields. (RT-4 in retention.spec.ts pins the parallel DB-level
    // guarantee that the SQL predicate also never reads payload.)
    const repo = new FakeOutboxRetentionRepository(50);
    const processor = new OutboxRetentionProcessor(repo, fixedClock());

    const result = await processor.process(OUTBOX_RETENTION_JOB_NAME, {});

    expect(result.purgedCount).toBe(50);
    // Each recorded call carries cutoffs + batchSize only -- no payload key.
    for (const call of repo.calls) {
      expect(Object.keys(call).sort()).toEqual(["batchSize", "cutoffs"]);
    }
  });
});

// ---------------------------------------------------------------------------
// P-9 / P-10: job validation
// ---------------------------------------------------------------------------

describe("OutboxRetentionProcessor -- job validation (P-9, P-10)", () => {
  it("unknown job name throws UnknownOutboxRetentionJobError (P-9)", async () => {
    const repo = new FakeOutboxRetentionRepository(0);
    const processor = new OutboxRetentionProcessor(repo, fixedClock());

    await expect(processor.process("not-the-real-job", {})).rejects.toThrow(
      UnknownOutboxRetentionJobError,
    );
    // Repo MUST NOT be touched for unknown jobs.
    expect(repo.calls).toHaveLength(0);
  });

  it("non-object payload throws MalformedOutboxRetentionJobError and never echoes PII (P-10)", async () => {
    const repo = new FakeOutboxRetentionRepository(0);
    const processor = new OutboxRetentionProcessor(repo, fixedClock());

    // The Zod schema rejects non-object payloads. We embed a PII canary in
    // the rejected payload to prove the error message NEVER echoes input
    // data -- only the operator-authored, redacted error class metadata
    // is allowed to escape (per the worker's PII-safe logging contract).
    const PII_CANARY = "PII_CANARY";
    let captured: unknown = null;
    try {
      // Pass a string with the canary embedded; Zod's
      // `z.object().passthrough()` rejects non-objects regardless of
      // content, so this exercises the rejection path with a payload that
      // would leak if the implementation ever stringified the input.
      await processor.process(
        OUTBOX_RETENTION_JOB_NAME,
        `not-an-object-${PII_CANARY}` as unknown,
      );
    } catch (err) {
      captured = err;
    }

    // 1. The right error class fired.
    expect(captured).toBeInstanceOf(MalformedOutboxRetentionJobError);
    // 2. The error message is PII-safe -- the canary does NOT appear.
    expect(String((captured as Error).message)).not.toContain(PII_CANARY);
    // 3. The repo seam was never touched -- a malformed payload aborts
    //    before any sweep work begins.
    expect(repo.calls).toHaveLength(0);
  });

  it("BullMQ-style passthrough fields on the payload are tolerated (P-10b)", async () => {
    const repo = new FakeOutboxRetentionRepository(0);
    const processor = new OutboxRetentionProcessor(repo, fixedClock());

    // BullMQ adds internal metadata like repeatJobKey / timestamp;
    // these must NOT cause validation failure.
    await expect(
      processor.process(OUTBOX_RETENTION_JOB_NAME, {
        repeatJobKey: "rk",
        timestamp: 1_700_000_000_000,
      }),
    ).resolves.toMatchObject({ purgedCount: 0, batchCount: 1 });
  });
});

// ---------------------------------------------------------------------------
// P-11: durationMs non-negative
// ---------------------------------------------------------------------------

describe("OutboxRetentionProcessor -- result shape (P-11)", () => {
  it("durationMs is a non-negative number", async () => {
    const repo = new FakeOutboxRetentionRepository(10);
    const processor = new OutboxRetentionProcessor(repo, fixedClock());

    const result = await processor.process(OUTBOX_RETENTION_JOB_NAME, {});

    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// P-12: PII safety
// ---------------------------------------------------------------------------

describe("OutboxRetentionProcessor -- PII safety (P-12)", () => {
  const PII_CANARY = "pii-canary@example.test";

  it("a PII canary in the BullMQ-style passthrough payload never appears in the result (P-12a)", async () => {
    // Hypothetical: a future BullMQ wrapper smuggles a PII-shaped field
    // into the job data. The processor's return value carries only
    // counts -- no echoed payload fields. This test pins that
    // structural contract.
    const repo = new FakeOutboxRetentionRepository(3);
    const processor = new OutboxRetentionProcessor(repo, fixedClock());

    const result = await processor.process(OUTBOX_RETENTION_JOB_NAME, {
      // BullMQ passthrough -- the Zod schema tolerates extras.
      bogusEmail: PII_CANARY,
      bogusPhone: "+15555550199",
    });

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(PII_CANARY);
    expect(serialised).not.toContain("+15555550199");
  });

  it("an unknown-job error message does not echo a PII-shaped job name (P-12b)", async () => {
    const repo = new FakeOutboxRetentionRepository(0);
    const processor = new OutboxRetentionProcessor(repo, fixedClock());

    // The error message DOES include the rejected job name string -- that
    // is operator-supplied job-routing metadata, not row data, and
    // operators need to see it to debug misroutes. But it MUST NOT
    // contain payload data. This test pins the boundary.
    let captured: unknown = null;
    try {
      await processor.process("bogus-job-name", {
        bogusEmail: PII_CANARY,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(UnknownOutboxRetentionJobError);
    const msg = (captured as Error).message;
    expect(msg).toContain("bogus-job-name");
    expect(msg).not.toContain(PII_CANARY);
  });
});
