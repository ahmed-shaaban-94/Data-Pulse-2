/**
 * apps/api/test/outbox/admin.query.schema.unit.spec.ts (T591, 1C-C1)
 *
 * Hermetic unit coverage for `OutboxAdminListQuerySchema`,
 * `encodeCursor`, `decodeCursor`, and the limit / cursor zod transforms.
 *
 * Why a SEPARATE unit spec instead of relying on the existing controller
 * + contract specs:
 *
 *   1. Functional coverage: `admin.controller.spec.ts` exercises the
 *      cursor codec only via supertest + the Zod cursor transform's
 *      happy path. Error branches (not-base64url, empty payload, missing
 *      separator, invalid occurred_at_text shape, invalid event_id,
 *      malformed limit) are reached only through HTTP-level rejection
 *      assertions, which give us "400 responded" but NOT line-level
 *      hits inside `decodeCursor`'s catch arms. Coverage tooling sees
 *      those branches as untaken.
 *
 *   2. CI worker-leak resilience: the contract / controller specs land
 *      in the same Jest worker as the AuthModule-booting controller
 *      specs (auth.controller, pos-shifts.controller, memberships.*,
 *      etc.) that boot a BullMQ Queue at module-init time. When that
 *      worker is force-killed at teardown, the partition's
 *      coverage-final.json never flushes -- everything that worker
 *      ran shows 0 % funcs. A hermetic spec (no Nest, no Pool, no
 *      Queue, no fs, no network) finishes in <50 ms and lands in a
 *      coverage-safe worker.
 *
 * Strategy: call the pure functions / parse via `safeParse` directly.
 * No supertest, no Nest moduleRef, no Postgres, no BullMQ.
 */
import {
  OutboxAdminListQuerySchema,
  decodeCursor,
  encodeCursor,
} from "../../src/outbox/admin.query.schema";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_UUID = "0e195b10-0000-7000-8000-000000000001";
const VALID_OCCURRED_AT_TEXT = "2026-05-19T10:00:00.123456Z";

// ===========================================================================
// encodeCursor / decodeCursor — pure codec
// ===========================================================================
describe("encodeCursor / decodeCursor (µs-precision contract)", () => {
  it("encodes a (text, eventId) tuple as base64url with no padding", () => {
    const encoded = encodeCursor(VALID_OCCURRED_AT_TEXT, VALID_UUID);
    // base64url MUST NOT use '+' or '/' or '=' padding.
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
  });

  it("round-trips encode -> decode losslessly (preserves microseconds)", () => {
    const encoded = encodeCursor(VALID_OCCURRED_AT_TEXT, VALID_UUID);
    const decoded = decodeCursor(encoded);
    // The 6 fractional digits MUST survive the round trip -- this is
    // the whole point of the µs-precision refactor.
    expect(decoded.occurredAtText).toBe(VALID_OCCURRED_AT_TEXT);
    expect(decoded.eventId).toBe(VALID_UUID);
  });

  it("decoded.occurredAtText is the literal verbatim string (NOT a Date)", () => {
    const encoded = encodeCursor(VALID_OCCURRED_AT_TEXT, VALID_UUID);
    const decoded = decodeCursor(encoded);
    expect(typeof decoded.occurredAtText).toBe("string");
    // If decode silently re-wrapped through a Date, the trailing
    // microsecond digits would be truncated to ms (".123Z").
    expect(decoded.occurredAtText.endsWith(".123456Z")).toBe(true);
  });

  it("rejects a payload with an empty body", () => {
    const empty = Buffer.from("", "utf8").toString("base64url");
    expect(() => decodeCursor(empty)).toThrow(/empty payload/);
  });

  it("rejects a payload with a leading separator (no occurredAt half)", () => {
    const bad = Buffer.from(`|${VALID_UUID}`, "utf8").toString("base64url");
    expect(() => decodeCursor(bad)).toThrow(/missing separator/);
  });

  it("rejects a payload with a trailing separator (no eventId half)", () => {
    const bad = Buffer.from(`${VALID_OCCURRED_AT_TEXT}|`, "utf8").toString(
      "base64url",
    );
    expect(() => decodeCursor(bad)).toThrow(/missing separator/);
  });

  it("rejects a payload with NO separator at all", () => {
    const bad = Buffer.from("nope", "utf8").toString("base64url");
    expect(() => decodeCursor(bad)).toThrow(/missing separator/);
  });

  it("rejects an occurredAtText that lacks microsecond precision (ms-only ISO)", () => {
    // This is the regression guard: a client building cursors from
    // `Date.toISOString()` would land here. The whitelist regex
    // requires exactly 6 fractional digits.
    const lossy = Buffer.from(
      `2026-05-19T10:00:00.123Z|${VALID_UUID}`,
      "utf8",
    ).toString("base64url");
    expect(() => decodeCursor(lossy)).toThrow(/invalid occurred_at/);
  });

  it("rejects an occurredAtText with timezone offset (must be UTC Z)", () => {
    const bad = Buffer.from(
      `2026-05-19T10:00:00.123456+02:00|${VALID_UUID}`,
      "utf8",
    ).toString("base64url");
    expect(() => decodeCursor(bad)).toThrow(/invalid occurred_at/);
  });

  it("rejects an occurredAtText with garbage characters", () => {
    const bad = Buffer.from(`not-a-time|${VALID_UUID}`, "utf8").toString(
      "base64url",
    );
    expect(() => decodeCursor(bad)).toThrow(/invalid occurred_at/);
  });

  it("rejects an eventId that is not a UUID", () => {
    const bad = Buffer.from(
      `${VALID_OCCURRED_AT_TEXT}|not-a-uuid`,
      "utf8",
    ).toString("base64url");
    expect(() => decodeCursor(bad)).toThrow(/invalid event_id/);
  });

  it("rejects an eventId with the right length but bad characters", () => {
    // 'g' is not a hex char.
    const bad = Buffer.from(
      `${VALID_OCCURRED_AT_TEXT}|0e195b10-0000-7000-8000-00000000000g`,
      "utf8",
    ).toString("base64url");
    expect(() => decodeCursor(bad)).toThrow(/invalid event_id/);
  });
});

// ===========================================================================
// OutboxAdminListQuerySchema — limit transform
// ===========================================================================
describe("OutboxAdminListQuerySchema.limit transform", () => {
  it("defaults to 50 when limit is omitted", () => {
    const parsed = OutboxAdminListQuerySchema.parse({});
    expect(parsed.limit).toBe(50);
  });

  it("accepts an integer NUMBER value directly", () => {
    // CodeRabbit-flagged branch: the union allows number | string. The
    // numeric branch was previously only reached through the controller's
    // query-string path, which always hands strings.
    const parsed = OutboxAdminListQuerySchema.parse({ limit: 25 });
    expect(parsed.limit).toBe(25);
  });

  it("accepts a string of digits and parses it", () => {
    const parsed = OutboxAdminListQuerySchema.parse({ limit: "100" });
    expect(parsed.limit).toBe(100);
  });

  it("rejects a string that is not a clean integer", () => {
    const result = OutboxAdminListQuerySchema.safeParse({ limit: "10.5" });
    expect(result.success).toBe(false);
  });

  it("rejects a string that is exponential notation", () => {
    const result = OutboxAdminListQuerySchema.safeParse({ limit: "3e2" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer NUMBER (float)", () => {
    // CodeRabbit-flagged branch: Number.isInteger check on the numeric path.
    const result = OutboxAdminListQuerySchema.safeParse({ limit: 10.5 });
    expect(result.success).toBe(false);
  });

  it("rejects 0 (below minimum)", () => {
    const result = OutboxAdminListQuerySchema.safeParse({ limit: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects negative integers", () => {
    const result = OutboxAdminListQuerySchema.safeParse({ limit: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects values above 200 (max)", () => {
    const result = OutboxAdminListQuerySchema.safeParse({ limit: 201 });
    expect(result.success).toBe(false);
    const numeric = OutboxAdminListQuerySchema.safeParse({ limit: 999 });
    expect(numeric.success).toBe(false);
  });

  it("accepts the boundary values 1 and 200", () => {
    expect(OutboxAdminListQuerySchema.parse({ limit: 1 }).limit).toBe(1);
    expect(OutboxAdminListQuerySchema.parse({ limit: 200 }).limit).toBe(200);
  });
});

// ===========================================================================
// OutboxAdminListQuerySchema — cursor transform
// ===========================================================================
describe("OutboxAdminListQuerySchema.cursor transform", () => {
  it("decodes a valid base64url cursor into a string-typed tuple", () => {
    const cursor = encodeCursor(VALID_OCCURRED_AT_TEXT, VALID_UUID);
    const parsed = OutboxAdminListQuerySchema.parse({ cursor });
    expect(parsed.cursor).toBeDefined();
    expect(parsed.cursor!.occurredAtText).toBe(VALID_OCCURRED_AT_TEXT);
    expect(parsed.cursor!.eventId).toBe(VALID_UUID);
  });

  it("propagates decodeCursor errors as a Zod validation_error issue", () => {
    // CodeRabbit-flagged branch: the transform's catch arm.
    const result = OutboxAdminListQuerySchema.safeParse({
      cursor: "not~~valid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty string cursor (min(1))", () => {
    const result = OutboxAdminListQuerySchema.safeParse({ cursor: "" });
    expect(result.success).toBe(false);
  });
});

// ===========================================================================
// OutboxAdminListQuerySchema — top-level shape
// ===========================================================================
describe("OutboxAdminListQuerySchema (top-level)", () => {
  it("rejects unknown query keys (strict mode)", () => {
    const result = OutboxAdminListQuerySchema.safeParse({ bogus: "x" });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed tenant_id (not a UUID)", () => {
    const result = OutboxAdminListQuerySchema.safeParse({
      tenant_id: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("accepts an empty object (all fields optional, limit defaults)", () => {
    const parsed = OutboxAdminListQuerySchema.parse({});
    expect(parsed.limit).toBe(50);
    expect(parsed.cursor).toBeUndefined();
    expect(parsed.event_type).toBeUndefined();
    expect(parsed.tenant_id).toBeUndefined();
  });

  it("threads through event_type as-is", () => {
    const parsed = OutboxAdminListQuerySchema.parse({
      event_type: "audit.event.created",
    });
    expect(parsed.event_type).toBe("audit.event.created");
  });

  it("threads through tenant_id when it is a valid UUID", () => {
    const parsed = OutboxAdminListQuerySchema.parse({
      tenant_id: "0a195b10-0000-7000-8000-000000000001",
    });
    expect(parsed.tenant_id).toBe("0a195b10-0000-7000-8000-000000000001");
  });

  it("rejects an event_type that is an empty string (min(1))", () => {
    const result = OutboxAdminListQuerySchema.safeParse({ event_type: "" });
    expect(result.success).toBe(false);
  });
});
