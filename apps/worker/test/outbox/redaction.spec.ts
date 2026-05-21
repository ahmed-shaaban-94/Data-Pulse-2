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
 *   matrix (`.specify/memory/redaction-matrix.md`, P3 / T440). The matrix
 *   amendment of 2026-05-21 (matrix §4.3 + §3.2 actor_label row) closed
 *   the originally-deferred gaps. This spec now asserts ALL matrix-protected
 *   paths the audit outbox envelope can carry:
 *     - matrix §3.2 + `*.X`               -> suites RD-1, RD-2, RD-3
 *     - matrix §3.2 actor_label           -> suite RD-4 (a, b, g)
 *     - matrix §4.3 payload.metadata.X    -> suite RD-4 (c, d, e, f, g)
 *     - matrix §4.3 *.metadata.X defense  -> suite RD-5 (a, b, c, d)
 *
 * What the matrix protects today (DEFAULT_REDACT_PATHS)
 * -----------------------------------------------------
 *   - top-level: `email`, `phone`, `full_name`, `given_name`,
 *     `family_name`, `display_name`, `date_of_birth`, `national_id`,
 *     `ip_address`, `actor_label`, ...
 *   - one-segment-nested (`*.X`): `*.email`, `*.phone`, `*.full_name`,
 *     `*.actor_label`, ...
 *   - free text: `note`, `comment`, `description`, `feedback`, `*.note`, ...
 *   - two-segment audit-envelope (T565 / matrix §4.3, 2026-05-21):
 *     `payload.metadata.{email,phone,full_name,note}` and the
 *     defensive `*.metadata.{email,phone,full_name,note}` family.
 *
 *   Pino's `*.X` wildcard matches a SINGLE segment only — see matrix §4.3
 *   for the depth limitation and the explicit two-segment paths it lists.
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
 * carries a mix of fields covered by the original matrix and fields
 * covered by the T565 / matrix §4.3 amendment (2026-05-21):
 *   - `payload.{email,phone,full_name}` — original `*.X` coverage.
 *   - `payload.actor_label`             — amendment `*.actor_label`.
 *   - `payload.metadata.{email,phone,full_name,note}` — amendment's
 *     explicit two-segment paths.
 *
 * Suite RD-4g asserts every redactable field in this envelope.
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
      // T565 / matrix §4.3 (2026-05-21) amendment-covered:
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
// Suite 4: Matrix-amendment closure (T565, matrix §4.3 2026-05-21)
// ---------------------------------------------------------------------------
//
// These assertions exercise the paths added to DEFAULT_REDACT_PATHS by the
// T565 matrix-amendment closure:
//
//   - `actor_label`            (audit job payload PII label)
//   - `*.actor_label`          (nested in `payload`, `event`, etc.)
//   - `payload.metadata.email`         (audit envelope nested PII)
//   - `payload.metadata.phone`
//   - `payload.metadata.full_name`
//   - `payload.metadata.note`          (free-text PII-suspect)
//   - `*.metadata.email`       (defensive: when the envelope is nested
//                               under a different one-segment prefix)
//   - `*.metadata.phone`
//   - `*.metadata.full_name`
//   - `*.metadata.note`
//
// Source of truth: `.specify/memory/redaction-matrix.md` §3.2 (actor_label)
// and §4.3 (pino wildcard depth + worker outbox envelope paths).
// ---------------------------------------------------------------------------
describe("outbox payload redaction -- matrix-amendment closure (RD-4)", () => {
  it("`actor_label` is redacted at the top level (RD-4a)", () => {
    const { dest, lines } = makeCapture();
    const logger = createLogger({ service: "worker", destination: dest });

    logger.info({ actor_label: PII_EMAIL }, "top-level actor_label");

    const last = lines().pop()!;
    expect(last["actor_label"]).toBe("[REDACTED]");
  });

  it("`payload.actor_label` is redacted via `*.actor_label` (RD-4b)", () => {
    const { dest, lines } = makeCapture();
    const logger = createLogger({ service: "worker", destination: dest });

    logger.info(
      { payload: { actor_label: PII_EMAIL } },
      "one-segment-nested actor_label",
    );

    const last = lines().pop()!;
    const payload = last["payload"] as Record<string, unknown>;
    expect(payload["actor_label"]).toBe("[REDACTED]");
  });

  it("`payload.metadata.email` is redacted (two-segment nesting) (RD-4c)", () => {
    const { dest, lines } = makeCapture();
    const logger = createLogger({ service: "worker", destination: dest });

    logger.info(
      { payload: { metadata: { email: PII_EMAIL } } },
      "two-segment metadata.email",
    );

    const last = lines().pop()!;
    const payload = last["payload"] as Record<string, unknown>;
    const metadata = payload["metadata"] as Record<string, unknown>;
    expect(metadata["email"]).toBe("[REDACTED]");
  });

  it("`payload.metadata.phone` is redacted (RD-4d)", () => {
    const { dest, lines } = makeCapture();
    const logger = createLogger({ service: "worker", destination: dest });

    logger.info(
      { payload: { metadata: { phone: PII_PHONE } } },
      "two-segment metadata.phone",
    );

    const last = lines().pop()!;
    const payload = last["payload"] as Record<string, unknown>;
    const metadata = payload["metadata"] as Record<string, unknown>;
    expect(metadata["phone"]).toBe("[REDACTED]");
  });

  it("`payload.metadata.full_name` is redacted (RD-4e)", () => {
    const { dest, lines } = makeCapture();
    const logger = createLogger({ service: "worker", destination: dest });

    logger.info(
      { payload: { metadata: { full_name: PII_NAME } } },
      "two-segment metadata.full_name",
    );

    const last = lines().pop()!;
    const payload = last["payload"] as Record<string, unknown>;
    const metadata = payload["metadata"] as Record<string, unknown>;
    expect(metadata["full_name"]).toBe("[REDACTED]");
  });

  it("`payload.metadata.note` is redacted (free-text PII-suspect) (RD-4f)", () => {
    const { dest, lines } = makeCapture();
    const logger = createLogger({ service: "worker", destination: dest });

    logger.info(
      { payload: { metadata: { note: "free-text PII suspect" } } },
      "two-segment metadata.note",
    );

    const last = lines().pop()!;
    const payload = last["payload"] as Record<string, unknown>;
    const metadata = payload["metadata"] as Record<string, unknown>;
    expect(metadata["note"]).toBe("[REDACTED]");
  });

  it("full outbox envelope: all matrix-amendment paths are redacted in a single log line (RD-4g)", () => {
    const { dest, lines } = makeCapture();
    const logger = createLogger({ service: "worker", destination: dest });

    logger.info(makeOutboxEventEnvelope(), "full envelope amendment check");

    const last = lines().pop()!;
    const payload = last["payload"] as Record<string, unknown>;
    expect(payload["actor_label"]).toBe("[REDACTED]");
    const metadata = payload["metadata"] as Record<string, unknown>;
    expect(metadata["email"]).toBe("[REDACTED]");
    expect(metadata["phone"]).toBe("[REDACTED]");
    expect(metadata["full_name"]).toBe("[REDACTED]");
    expect(metadata["note"]).toBe("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Defensive `*.metadata.*` paths -- nested envelope coverage
// ---------------------------------------------------------------------------
//
// The matrix amendment also adds `*.metadata.X` paths so a call site that
// binds the envelope under a one-segment prefix other than `payload`
// (e.g., `event`, `row`, `outbox`) still has its metadata PII redacted.
// These paths use pino's single-segment wildcard one level deeper than
// the original `*.X` set.
// ---------------------------------------------------------------------------
describe("outbox payload redaction -- defensive *.metadata.* paths (RD-5)", () => {
  it("`event.metadata.email` is redacted via `*.metadata.email` (RD-5a)", () => {
    const { dest, lines } = makeCapture();
    const logger = createLogger({ service: "worker", destination: dest });

    logger.info(
      { event: { metadata: { email: PII_EMAIL } } },
      "one-segment-prefix metadata.email",
    );

    const last = lines().pop()!;
    const event = last["event"] as Record<string, unknown>;
    const metadata = event["metadata"] as Record<string, unknown>;
    expect(metadata["email"]).toBe("[REDACTED]");
  });

  it("`row.metadata.phone` is redacted via `*.metadata.phone` (RD-5b)", () => {
    const { dest, lines } = makeCapture();
    const logger = createLogger({ service: "worker", destination: dest });

    logger.info(
      { row: { metadata: { phone: PII_PHONE } } },
      "one-segment-prefix metadata.phone",
    );

    const last = lines().pop()!;
    const row = last["row"] as Record<string, unknown>;
    const metadata = row["metadata"] as Record<string, unknown>;
    expect(metadata["phone"]).toBe("[REDACTED]");
  });

  it("`outbox.metadata.full_name` is redacted via `*.metadata.full_name` (RD-5c)", () => {
    const { dest, lines } = makeCapture();
    const logger = createLogger({ service: "worker", destination: dest });

    logger.info(
      { outbox: { metadata: { full_name: PII_NAME } } },
      "one-segment-prefix metadata.full_name",
    );

    const last = lines().pop()!;
    const outbox = last["outbox"] as Record<string, unknown>;
    const metadata = outbox["metadata"] as Record<string, unknown>;
    expect(metadata["full_name"]).toBe("[REDACTED]");
  });

  it("`envelope.metadata.note` is redacted via `*.metadata.note` (RD-5d)", () => {
    const { dest, lines } = makeCapture();
    const logger = createLogger({ service: "worker", destination: dest });

    logger.info(
      { envelope: { metadata: { note: "free-text PII suspect" } } },
      "one-segment-prefix metadata.note",
    );

    const last = lines().pop()!;
    const envelope = last["envelope"] as Record<string, unknown>;
    const metadata = envelope["metadata"] as Record<string, unknown>;
    expect(metadata["note"]).toBe("[REDACTED]");
  });
});
