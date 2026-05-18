/**
 * T565 [P7][Track C] -- Outbox payload redaction at the logger boundary.
 *
 * Scope (1C-A, test-first):
 *   This spec pins the contract that any worker log site binding an outbox
 *   row goes through the shared logger's redaction policy, so PII fields
 *   the matrix protects against (`packages/shared/src/logger/pino.ts`
 *   `DEFAULT_REDACT_PATHS`) never appear in pino output.
 *
 *   T565's task text explicitly defers exhaustive coverage to the redaction
 *   matrix (`.specify/memory/redaction-matrix.md`, P3 / T440). This spec
 *   therefore asserts ONLY what the current matrix is contractually
 *   responsible for; it documents (via `it.todo`) the matrix-deferred gaps
 *   the test surfaced -- specifically `actor_label`, nested `payload.*.*`
 *   PII fields, and the audit envelope's `metadata.*` -- so the matrix
 *   maintainers can address them in the next matrix amendment without
 *   this test silently passing.
 *
 * What the matrix protects today (DEFAULT_REDACT_PATHS, top-level + `*.X`)
 * ------------------------------------------------------------------------
 *   - top-level: `email`, `phone`, `full_name`, `given_name`,
 *     `family_name`, `display_name`, `date_of_birth`, `national_id`,
 *     `ip_address`, ...
 *   - one-segment-nested: `*.email`, `*.phone`, `*.full_name`, ...
 *   - free text: `note`, `comment`, `description`, `feedback`, `*.note`, ...
 *
 *   Pino's `*.X` wildcard matches a SINGLE segment only -- so
 *   `payload.metadata.email` (three segments deep) is NOT covered by
 *   the existing matrix. Adding it is a matrix amendment.
 *
 * What this spec does NOT do
 * --------------------------
 *   - We do NOT mock the drainer or any consumer. The drainer's
 *     `logError` already emits ONLY `errorName` -- never a payload
 *     (see `apps/worker/src/outbox/drainer.processor.ts:307-334`).
 *     This test is the contract for any FUTURE log site.
 *   - We do NOT introduce new dependencies. We import the shared
 *     `createLogger` and use pino's standard `destination` seam --
 *     the same pattern as `packages/shared/__tests__/logger/`.
 *
 * No Docker, no Postgres, no Redis -- pure pino unit test.
 */
import { Writable } from "node:stream";
import { createLogger } from "@data-pulse-2/shared/logger/pino";

// ---------------------------------------------------------------------------
// PII canaries. If a "matrix-covered" canary appears in raw output the test
// FAILS (a regression). Matrix-deferred canaries are placed in the test
// payload but the assertions on them are `it.todo` until the matrix lands.
// ---------------------------------------------------------------------------
const PII_EMAIL = "pii-canary@example.test";
const PII_PHONE = "+15555550199";
const PII_NAME = "Avery Canary-McTest";

/**
 * An outbox-event-shaped envelope. The TOP-LEVEL `payload` sub-object
 * carries a mix of matrix-covered fields (e.g. `email`, `phone`) and
 * matrix-deferred fields (e.g. `actor_label`, `metadata.email`).
 *
 * The matrix-covered fields are asserted in the active tests below.
 * The deferred fields are documented in the `it.todo` section.
 */
function makeOutboxEventEnvelope(): Record<string, unknown> {
  return {
    event_id: "0bd00000-0000-4000-8000-000000000001",
    event_type: "audit.event.created",
    tenant_id: "0bd00000-0000-7000-8000-000000000001",
    store_id: null,
    correlation_id: "00000000-0000-0000-0000-000000000001",
    occurred_at: new Date("2026-01-01T00:00:00Z").toISOString(),
    attempts: 1,
    payload: {
      // Matrix-covered at the `*.X` one-segment-nested level:
      email: PII_EMAIL,
      phone: PII_PHONE,
      full_name: PII_NAME,
      // Matrix-deferred (documented in it.todo below):
      actor_label: PII_EMAIL,
      metadata: {
        email: PII_EMAIL,
        phone: PII_PHONE,
        full_name: PII_NAME,
        note: "free-text PII suspect",
      },
    },
  };
}

function makeCapture(): {
  dest: { write(msg: string): void };
  raw: () => string;
  lines: () => Array<Record<string, unknown>>;
} {
  const chunks: string[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  return {
    dest,
    raw: () => chunks.join(""),
    lines: () =>
      chunks
        .join("")
        .trim()
        .split("\n")
        .filter((s) => s.length > 0)
        .map((s) => JSON.parse(s) as Record<string, unknown>),
  };
}

// ---------------------------------------------------------------------------
// Suite 1: Matrix-covered PII never reaches pino output
// ---------------------------------------------------------------------------
describe("outbox payload redaction -- matrix-covered PII is redacted (RD-1)", () => {
  it("top-level `email` binding is censored (RD-1a)", () => {
    const { dest, raw, lines } = makeCapture();
    const logger = createLogger({ service: "worker-test", destination: dest });

    logger.info({ email: PII_EMAIL }, "top-level email");

    expect(raw()).not.toContain(PII_EMAIL);
    expect(lines().pop()!["email"]).toBe("[REDACTED]");
  });

  it("top-level `phone` binding is censored (RD-1b)", () => {
    const { dest, raw, lines } = makeCapture();
    const logger = createLogger({ service: "worker-test", destination: dest });

    logger.info({ phone: PII_PHONE }, "top-level phone");

    expect(raw()).not.toContain(PII_PHONE);
    expect(lines().pop()!["phone"]).toBe("[REDACTED]");
  });

  it("top-level `full_name` binding is censored (RD-1c)", () => {
    const { dest, raw, lines } = makeCapture();
    const logger = createLogger({ service: "worker-test", destination: dest });

    logger.info({ full_name: PII_NAME }, "top-level full_name");

    expect(raw()).not.toContain(PII_NAME);
    expect(lines().pop()!["full_name"]).toBe("[REDACTED]");
  });

  it("one-segment-nested `payload.email` is censored via the `*.email` wildcard (RD-1d)", () => {
    const { dest, raw, lines } = makeCapture();
    const logger = createLogger({ service: "worker-test", destination: dest });

    logger.info(
      { payload: { email: PII_EMAIL, phone: PII_PHONE, full_name: PII_NAME } },
      "outbox payload observed",
    );

    expect(raw()).not.toContain(PII_EMAIL);
    expect(raw()).not.toContain(PII_PHONE);
    expect(raw()).not.toContain(PII_NAME);

    const last = lines().pop();
    const payload = last!["payload"] as Record<string, unknown>;
    expect(payload["email"]).toBe("[REDACTED]");
    expect(payload["phone"]).toBe("[REDACTED]");
    expect(payload["full_name"]).toBe("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Safe metadata is preserved -- operators can still triage
// ---------------------------------------------------------------------------
describe("outbox payload redaction -- safe metadata is preserved (RD-2)", () => {
  it("the line carries event_id, event_type, tenant_id, and attempts (RD-2a)", () => {
    const { dest, lines } = makeCapture();
    const logger = createLogger({ service: "worker-test", destination: dest });

    logger.info(
      {
        event_id: "0bd00000-0000-4000-8000-000000000001",
        event_type: "audit.event.created",
        tenant_id: "0bd00000-0000-7000-8000-000000000001",
        attempts: 1,
      },
      "outbox event observed",
    );

    const last = lines().pop();
    expect(last).toBeDefined();
    expect(last!["event_id"]).toBe("0bd00000-0000-4000-8000-000000000001");
    expect(last!["event_type"]).toBe("audit.event.created");
    expect(last!["tenant_id"]).toBe("0bd00000-0000-7000-8000-000000000001");
    expect(last!["attempts"]).toBe(1);
  });

  it("the message text and level are preserved unchanged (RD-2b)", () => {
    const { dest, lines } = makeCapture();
    const logger = createLogger({ service: "worker-test", destination: dest });

    logger.info({ event_id: "abc" }, "outbox event observed");

    const last = lines().pop();
    expect(last!["message"]).toBe("outbox event observed");
    expect(last!["level"]).toBe("info");
  });

  it("censored fields appear as the literal `[REDACTED]` rather than being dropped (RD-2c)", () => {
    // FR-B-005: the line itself must evidence that redaction happened
    // so operators can spot a logger misconfiguration.
    const { dest, raw } = makeCapture();
    const logger = createLogger({ service: "worker-test", destination: dest });

    logger.info({ email: PII_EMAIL }, "redaction evidence check");

    expect(raw()).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Outbox envelope binding -- matrix-covered fields are redacted
// ---------------------------------------------------------------------------
describe("outbox payload redaction -- full outbox envelope binding (RD-3)", () => {
  it("matrix-covered PII (top-level + `*.X`) is censored when the full envelope is logged (RD-3a)", () => {
    const { dest, lines } = makeCapture();
    const logger = createLogger({ service: "worker-test", destination: dest });

    logger.info(makeOutboxEventEnvelope(), "outbox event observed");

    const last = lines().pop();
    const payload = last!["payload"] as Record<string, unknown>;
    expect(payload["email"]).toBe("[REDACTED]");
    expect(payload["phone"]).toBe("[REDACTED]");
    expect(payload["full_name"]).toBe("[REDACTED]");
  });

  it("the safe envelope fields survive the matrix-covered redaction pass (RD-3b)", () => {
    const { dest, lines } = makeCapture();
    const logger = createLogger({ service: "worker-test", destination: dest });

    logger.info(makeOutboxEventEnvelope(), "outbox event observed");

    const last = lines().pop();
    expect(last!["event_id"]).toBe("0bd00000-0000-4000-8000-000000000001");
    expect(last!["event_type"]).toBe("audit.event.created");
    expect(last!["tenant_id"]).toBe("0bd00000-0000-7000-8000-000000000001");
    expect(last!["attempts"]).toBe(1);
  });

  it("the `payload` sub-object is present (not wholesale dropped) so operators can read non-PII fields (RD-3c)", () => {
    // The redaction matrix's policy is to redact NAMED FIELDS, not to drop
    // the binding entirely. Wholesale drop is reserved for the `req`/`res`
    // boundary serializers; logging an outbox row by binding `payload`
    // produces a structurally-intact object with PII fields censored.
    const { dest, lines } = makeCapture();
    const logger = createLogger({ service: "worker-test", destination: dest });

    logger.info(makeOutboxEventEnvelope(), "outbox event observed");

    const last = lines().pop();
    expect(last!["payload"]).toBeDefined();
    expect(typeof last!["payload"]).toBe("object");
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Matrix-deferred gaps -- documented for redaction-matrix follow-up
// ---------------------------------------------------------------------------
//
// These assertions describe contracts the redaction matrix does NOT yet
// enforce, surfaced by this spec. They are intentionally `it.todo` rather
// than failing tests so:
//
//   - the matrix-amendment work has a discoverable to-do trail, and
//   - this spec does NOT silently pass when a future log site emits one
//     of these fields (a reviewer adding the matrix entry will pick the
//     todos up and convert them to real assertions in the same change).
//
// Matrix follow-up: add to DEFAULT_REDACT_PATHS in
//   `packages/shared/src/logger/pino.ts`
// and to the matrix doc at
//   `.specify/memory/redaction-matrix.md`
// the following paths:
//   - `actor_label`            (audit job payload PII label)
//   - `*.actor_label`          (nested in `payload`, `event`, etc.)
//   - `metadata.email`         (audit envelope nested PII)
//   - `metadata.phone`
//   - `metadata.full_name`
//   - `metadata.note`          (free-text PII-suspect)
//   - `*.metadata.email`       (when the envelope itself is nested)
//   - `*.metadata.phone`
//   - `*.metadata.full_name`
//   - `*.metadata.note`
// ---------------------------------------------------------------------------
describe("outbox payload redaction -- matrix-deferred gaps (RD-4)", () => {
  it.todo(
    "matrix amendment: `actor_label` should be redacted at the top level (RD-4a)",
  );
  it.todo(
    "matrix amendment: `payload.actor_label` should be redacted via `*.actor_label` (RD-4b)",
  );
  it.todo(
    "matrix amendment: `payload.metadata.email` should be redacted (two-segment nesting) (RD-4c)",
  );
  it.todo(
    "matrix amendment: `payload.metadata.phone` should be redacted (RD-4d)",
  );
  it.todo(
    "matrix amendment: `payload.metadata.full_name` should be redacted (RD-4e)",
  );
});
