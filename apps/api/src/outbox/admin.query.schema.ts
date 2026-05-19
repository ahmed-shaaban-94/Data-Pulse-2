/**
 * admin.query.schema.ts — Zod schema + cursor codec for
 * `GET /api/v1/admin/outbox/dead-letters` (T591, OpenAPI listOutboxDeadLetters).
 *
 * Mirrors `audit.query.schema.ts` so a reviewer can audit one cursor
 * convention for the whole API surface. Differences are intentional and
 * called out below.
 *
 * Limit semantics
 * ---------------
 * Default 50, accepts 1..200, rejects out-of-range with a ZodError that
 * the GlobalExceptionFilter renders as a 400 `validation_error`. No
 * silent clamping (same rule as audit).
 *
 * Cursor codec
 * ------------
 * Base64url-encoded `<occurredAtIso>|<eventId>`. Decoding happens inside
 * `.transform()` so a malformed cursor surfaces as the same 400 envelope
 * as any other bad query parameter. The controller never sees a raw string.
 *
 * Difference from audit: this endpoint is platform-scoped (no tenant
 * context), so the cursor's safety story is different:
 *   - audit cursors are tenant-safe because the repo predicate adds
 *     `WHERE tenant_id = ctx.tenantId`;
 *   - dead-letter cursors are administrator-context cursors — a leaked
 *     cursor would reveal an `(occurred_at, event_id)` tuple that the
 *     operator already had access to. Acceptable: the endpoint is gated
 *     by `@PlatformAdminOnly` and the cursor encodes no new privilege.
 *
 * HMAC signing remains deferred (same posture as audit); a future
 * hardening pass can add it without changing the wire format.
 */
import { z } from "zod";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whitelist regex for the cursor's occurred_at text component. The
 * repository projects PostgreSQL `timestamptz` columns through
 * `to_char(... AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
 * which preserves microsecond precision. Anchoring on that exact shape
 * rejects truncated / fabricated cursor inputs without going through
 * the lossy `Date` ctor (a JS `Date` parses ISO strings at millisecond
 * resolution -- the four trailing microsecond digits would be silently
 * discarded, breaking keyset pagination across rows that share a
 * millisecond bucket but differ in microseconds).
 */
const OCCURRED_AT_TEXT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * Internal contract between schema, service, and repository.
 *
 * `occurredAtText` is the **lossless** representation of the row's
 * `occurred_at` timestamptz with microsecond precision -- carried as
 * a string end-to-end so the keyset predicate can compare against
 * `$N::timestamptz` without ever round-tripping through a millisecond-
 * precision JS `Date`. See `repository.ts` (mapRow) for the projection.
 */
export interface OutboxAdminCursor {
  readonly occurredAtText: string;
  readonly eventId: string;
}

/**
 * Encode `(occurredAtText, eventId)` as opaque base64url.
 *
 * Both parts are passed through verbatim -- callers MUST hand the same
 * string the repository projected (microsecond-precision UTC
 * timestamptz text). The codec is intentionally a pure byte
 * transformation; it does NOT re-parse the timestamp.
 */
export function encodeCursor(occurredAtText: string, eventId: string): string {
  const payload = `${occurredAtText}|${eventId}`;
  return Buffer.from(payload, "utf8").toString("base64url");
}

/**
 * Decode opaque base64url cursor back to `(occurredAtText, eventId)`.
 * Throws on any malformed shape so the Zod transform can surface it as
 * a `validation_error` 400.
 *
 * The timestamp half is validated against `OCCURRED_AT_TEXT_RE` -- we
 * deliberately do NOT call `new Date(isoPart)` (lossy: JS Date is
 * ms-precision; the 4 trailing microsecond digits would be silently
 * dropped, defeating the whole point of the precision tightening).
 * Postgres consumes the literal string directly via `$N::timestamptz`.
 */
export function decodeCursor(raw: string): OutboxAdminCursor {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw new Error("cursor: not base64url");
  }
  if (decoded.length === 0) {
    throw new Error("cursor: empty payload");
  }
  const sep = decoded.indexOf("|");
  if (sep <= 0 || sep === decoded.length - 1) {
    throw new Error("cursor: missing separator");
  }
  const occurredAtText = decoded.slice(0, sep);
  const idPart = decoded.slice(sep + 1);
  if (!OCCURRED_AT_TEXT_RE.test(occurredAtText)) {
    throw new Error("cursor: invalid occurred_at");
  }
  if (!UUID_RE.test(idPart)) {
    throw new Error("cursor: invalid event_id");
  }
  return { occurredAtText, eventId: idPart };
}

/**
 * Limit parser identical in shape to audit.query.schema.ts.
 * Strict integer parsing — `"10.5"`, `"3e2"`, `"abc"` all fail.
 */
const limitField = z
  .union([z.string(), z.number()])
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) return 50;
    let n: number;
    if (typeof value === "number") {
      n = value;
    } else {
      if (!/^-?\d+$/.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "limit must be an integer",
        });
        return z.NEVER;
      }
      n = Number.parseInt(value, 10);
    }
    if (!Number.isInteger(n) || n < 1 || n > 200) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "limit must be between 1 and 200",
      });
      return z.NEVER;
    }
    return n;
  });

/**
 * Zod schema for the list endpoint's query string.
 *
 *   - event_type : optional registry-controlled string (≥1 char)
 *   - tenant_id  : optional UUID
 *   - cursor     : optional opaque cursor (decoded to OutboxAdminCursor)
 *   - limit      : integer 1..200, default 50
 *
 * `.strict()` rejects unknown query params with a 400 — keeps the surface
 * minimal and prevents typos from silently dropping filters.
 */
export const OutboxAdminListQuerySchema = z
  .object({
    event_type: z.string().min(1).optional(),
    tenant_id: z
      .string()
      .regex(UUID_RE, "must be a UUID")
      .optional(),
    cursor: z
      .string()
      .min(1)
      .transform((raw, ctx) => {
        try {
          return decodeCursor(raw);
        } catch (err) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: err instanceof Error ? err.message : "cursor: malformed",
          });
          return z.NEVER;
        }
      })
      .optional(),
    limit: limitField,
  })
  .strict();

export type OutboxAdminListQueryInput = z.input<
  typeof OutboxAdminListQuerySchema
>;
export type OutboxAdminListQueryParsed = z.output<
  typeof OutboxAdminListQuerySchema
>;
