/**
 * T462 — PII canary redaction at the logger boundary.
 *
 * Proves the redaction matrix (`.specify/memory/redaction-matrix.md`) is
 * wired at the logger boundary (FR-B-005, T473) — not at call sites.
 *
 * Strategy
 * --------
 * Drive `createLogger(...)` directly with a capturing destination stream.
 * Emit log payloads that contain the `pii-canary@example.test` sentinel in
 * each of the matrix's classification zones (credential, PII, PII-suspect,
 * body, nested). Assert:
 *
 *   1. The literal canary string NEVER appears anywhere in the rendered
 *      JSON output of any log line.
 *   2. The canary is replaced by `[REDACTED]` for redacted-path emissions.
 *   3. The boundary serializers DROP bodies wholesale (req.body, res.body),
 *      so a canary deep inside a body cannot leak via a `{req}` log call.
 *
 * Why a unit-level test against pino directly
 * --------------------------------------------
 * The contract under test is "the logger boundary redacts PII." That is a
 * property of `createLogger(...)` itself; layering a Nest harness on top
 * would add coupling without strengthening the proof. The
 * pre-flight plan's §7.2 sketch of a `/test-canary` fixture endpoint is
 * deliberately rejected here for two reasons: (a) it would require either
 * a NODE_ENV-gated controller in `src/` (which we refuse — runtime code
 * MUST NOT contain test-only fixtures) or scaffolding a one-off Nest
 * controller in test code; (b) the proof would be identical because the
 * fixture's only job is to feed canary-bearing data into pino, which we do
 * here directly. The test is faster, more deterministic, and cheaper to
 * maintain. Spec parity is preserved by exercising every classification
 * zone (`credentials`, `PII`, `PII-suspect`, body, nested).
 *
 * `/metrics` validation is deferred — T483's full operator validation
 * requires the (gated) API/DB/worker metric-emission slices to exist
 * first. This test focuses on the logger surface only.
 */
import { Writable } from "node:stream";
import { createLogger } from "@data-pulse-2/shared";

const PII_CANARY = "pii-canary@example.test";

/** Capture every chunk pino writes. Each call to logger.<level>(...) lands as one JSON line. */
function makeCapture(): {
  destination: { write(msg: string): void };
  rendered: () => string;
  lines: () => string[];
} {
  const chunks: string[] = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  return {
    destination: dest,
    rendered: () => chunks.join(""),
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0),
  };
}

describe("logger-boundary redaction — PII canary at every emission site (T462)", () => {
  it("redacts `email` field at the top level", () => {
    const cap = makeCapture();
    const logger = createLogger({ service: "test-svc", destination: cap.destination });
    logger.info({ email: PII_CANARY }, "user lookup");

    const out = cap.rendered();
    expect(out).not.toContain(PII_CANARY);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts nested `email` field via the `*.email` wildcard", () => {
    const cap = makeCapture();
    const logger = createLogger({ service: "test-svc", destination: cap.destination });
    logger.info({ user: { email: PII_CANARY } }, "nested PII");

    const out = cap.rendered();
    expect(out).not.toContain(PII_CANARY);
  });

  it("redacts a deep credential-shaped field via the `*.password` wildcard", () => {
    const cap = makeCapture();
    const logger = createLogger({ service: "test-svc", destination: cap.destination });
    logger.info({ creds: { password: "hunter2" } }, "auth attempt");

    const out = cap.rendered();
    expect(out).not.toContain("hunter2");
  });

  it("redacts an `Authorization` header on a `req` binding", () => {
    const cap = makeCapture();
    const logger = createLogger({ service: "test-svc", destination: cap.destination });
    // Note: the boundary `req` serializer drops `headers` entirely — but the
    // redact-paths tripwire (`req.headers.authorization`) is the second-line
    // defense for any consumer that overrides the serializer. We exercise both
    // by passing a fake `req` shape that survives the serializer's reduction.
    logger.info(
      {
        req: {
          method: "POST",
          url: "/v1/auth/signin",
          headers: {
            authorization: "Bearer SUPER_SECRET_TOKEN_VALUE",
            cookie: "session=ALSO_SECRET",
          },
        },
      },
      "request received",
    );

    const out = cap.rendered();
    expect(out).not.toContain("SUPER_SECRET_TOKEN_VALUE");
    expect(out).not.toContain("ALSO_SECRET");
  });

  it("drops a full request body wholesale (matrix §3.3, FR-B-005)", () => {
    const cap = makeCapture();
    const logger = createLogger({ service: "test-svc", destination: cap.destination });
    logger.info(
      {
        req: {
          method: "POST",
          url: "/v1/auth/signin",
          body: {
            email: PII_CANARY,
            password: "hunter2",
            note: "a free-text field with the canary too: " + PII_CANARY,
          },
        },
      },
      "request received with body",
    );

    const out = cap.rendered();
    // The serializer must NOT emit `body` at all (no key, no value).
    expect(out).not.toContain(PII_CANARY);
    expect(out).not.toContain("hunter2");
    // Sanity: the serializer's safe envelope IS emitted.
    expect(out).toMatch(/"method":"POST"/);
  });

  it("drops a full response body wholesale", () => {
    const cap = makeCapture();
    const logger = createLogger({ service: "test-svc", destination: cap.destination });
    logger.info(
      {
        res: {
          statusCode: 200,
          body: { email: PII_CANARY, full_name: "Canary Q. PII" },
        },
      },
      "response sent",
    );

    const out = cap.rendered();
    expect(out).not.toContain(PII_CANARY);
    expect(out).not.toContain("Canary Q. PII");
    expect(out).toMatch(/"status":200/);
  });

  it("`err` serializer drops custom enumerable properties that may carry PII", () => {
    const cap = makeCapture();
    const logger = createLogger({ service: "test-svc", destination: cap.destination });
    class CustomError extends Error {
      constructor(message: string, public payload: { email: string }) {
        super(message);
        this.name = "CustomError";
      }
    }
    logger.error({ err: new CustomError("kaboom", { email: PII_CANARY }) }, "handler failed");

    const out = cap.rendered();
    expect(out).not.toContain(PII_CANARY);
    // The class name and message ARE allowed (matrix §3.4 — class name is
    // business-class; message is sanitized by the application). Our test
    // message contains no PII; the type label survives.
    expect(out).toContain("CustomError");
    expect(out).toContain("kaboom");
  });

  it("redacts a credential-shaped field even when bound under an unusual key", () => {
    const cap = makeCapture();
    const logger = createLogger({ service: "test-svc", destination: cap.destination });
    // Top-level `secret` and `idempotency_key` are in DEFAULT_REDACT_PATHS.
    logger.warn(
      { secret: "abcdef", idempotency_key: "raw-key-from-client", refresh_token: "rt_v1_..." },
      "credential probe",
    );

    const out = cap.rendered();
    expect(out).not.toContain("abcdef");
    expect(out).not.toContain("raw-key-from-client");
    expect(out).not.toContain("rt_v1_...");
  });

  it("a PII free-text field (`note`) under a nested key is redacted via wildcard", () => {
    const cap = makeCapture();
    const logger = createLogger({ service: "test-svc", destination: cap.destination });
    logger.info(
      { event: { note: PII_CANARY } },
      "user posted a note",
    );

    const out = cap.rendered();
    expect(out).not.toContain(PII_CANARY);
  });

  it("emits the structured-log fields (request_id, tenant_id, etc.) when present", () => {
    // T474 contract: `withRequestContext` SHOULD emit the FR-B-004 field set.
    // This test stays at the redaction surface — it merely confirms that
    // when those fields ARE bound, they are NOT in the redact list (they
    // are matrix §3.4 business-class identifiers, safe to log).
    const cap = makeCapture();
    const logger = createLogger({
      service: "test-svc",
      destination: cap.destination,
      bindings: {
        // mimics what withRequestContext would attach
        request_id: "req-123",
        tenant_id: "tenant-abc",
        store_id: "store-xyz",
        user_id: "user-42",
        actor_id: "user-42",
        correlation_id: "req-123",
      },
    });
    logger.info({ method: "GET", route: "/v1/context/me", status: 200 }, "request completed");

    const out = cap.rendered();
    expect(out).toMatch(/"request_id":"req-123"/);
    expect(out).toMatch(/"tenant_id":"tenant-abc"/);
    expect(out).toMatch(/"store_id":"store-xyz"/);
    expect(out).toMatch(/"user_id":"user-42"/);
    expect(out).toMatch(/"actor_id":"user-42"/);
    expect(out).toMatch(/"correlation_id":"req-123"/);
  });

  it("emits exactly one JSON line per log call (no stray output)", () => {
    const cap = makeCapture();
    const logger = createLogger({ service: "test-svc", destination: cap.destination });
    logger.info("line 1");
    logger.info("line 2");
    logger.warn("line 3");

    expect(cap.lines()).toHaveLength(3);
  });
});

/**
 * Cross-cutting end-to-end: a PII canary in any sub-shape should NEVER
 * appear in rendered output, regardless of how it arrives.
 *
 * This is the safety net against future contributors adding a binding the
 * matrix didn't anticipate.
 */
describe("logger-boundary redaction — canary is invisible across all emission shapes", () => {
  const PERMUTATIONS: Array<[string, () => Record<string, unknown>]> = [
    ["top-level email", () => ({ email: PII_CANARY })],
    ["nested under `user`", () => ({ user: { email: PII_CANARY } })],
    ["nested under `payload.body`", () => ({ payload: { body: { email: PII_CANARY } } })],
    ["inside a `req.body`", () => ({ req: { body: { email: PII_CANARY } } })],
    ["inside a `res.body`", () => ({ res: { body: { email: PII_CANARY } } })],
    ["inside a `note` free-text", () => ({ note: `please call ${PII_CANARY}` })],
    [
      "inside a custom error's enumerable property",
      () => {
        const err = new Error("oops") as Error & { extra?: unknown };
        err.extra = { email: PII_CANARY };
        return { err };
      },
    ],
  ];

  for (const [label, build] of PERMUTATIONS) {
    it(`does not leak the canary for: ${label}`, () => {
      const cap = makeCapture();
      const logger = createLogger({ service: "test-svc", destination: cap.destination });
      logger.info(build(), "permutation");
      expect(cap.rendered()).not.toContain(PII_CANARY);
    });
  }
});
