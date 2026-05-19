/**
 * apps/api/test/outbox/admin.service.unit.spec.ts (T591, 1C-C1)
 *
 * Hermetic unit coverage for `OutboxAdminService`.
 *
 * The existing controller / contract specs replace the service with a
 * `useValue: fakeService` -- so the real `list` / `get` / `toDto`
 * implementations and the µs-precision `next_cursor` build path are
 * never exercised. This spec fills that gap WITHOUT booting Nest,
 * Postgres, or BullMQ.
 *
 * Strategy: `jest.mock("@data-pulse-2/db")` so `listDeadLettered` and
 * `getDeadLettered` are pure spies. We construct the service with a
 * null pool (the spies ignore it) and verify the service's input /
 * output projection contract.
 *
 * Pinned behaviour:
 *   - constructor accepts the Pool token and stores it
 *   - list() forwards optional filters (eventType, tenantId, cursor)
 *     only when the caller provided them (no `undefined` overspread)
 *   - list() fetches `limit + 1` and detects end-of-page in one trip
 *   - list() builds `next_cursor` from the LAST KEPT row's
 *     `occurred_at_text` (µs-precision), NEVER from `occurred_at`
 *     (which would silently truncate to milliseconds)
 *   - list() returns `next_cursor: null` when the page is the last
 *   - list() returns `next_cursor: null` on an empty page even when
 *     hasMore would be false vacuously
 *   - get() returns the projected DTO when the repository returns a row
 *   - get() returns null when the repository returns null
 *   - the DTO projects Date columns through `.toISOString()` (ms-
 *     precision is fine on the wire; the cursor is the only place that
 *     needs µs precision)
 *   - `last_error_class` is forwarded verbatim from the record
 *     (the service does NOT re-sanitize -- that's the repo's job)
 */

// Mock the DB module BEFORE importing the service so its bindings see
// the spies. The mock factory returns jest.fn() spies that tests can
// configure per-case via `mockResolvedValue`.
jest.mock("@data-pulse-2/db", () => ({
  __esModule: true,
  listDeadLettered: jest.fn(),
  getDeadLettered: jest.fn(),
}));

import {
  getDeadLettered as _getDeadLetteredRaw,
  listDeadLettered as _listDeadLetteredRaw,
  type OutboxDeadLetterRecord,
} from "@data-pulse-2/db";
import type { Pool } from "pg";

import { OutboxAdminService } from "../../src/outbox/admin.service";
import { encodeCursor } from "../../src/outbox/admin.query.schema";

const listDeadLettered = _listDeadLetteredRaw as jest.MockedFunction<
  typeof _listDeadLetteredRaw
>;
const getDeadLettered = _getDeadLetteredRaw as jest.MockedFunction<
  typeof _getDeadLetteredRaw
>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POOL_STUB = null as unknown as Pool;
const TENANT_A = "0a195b10-0000-7000-8000-000000000001";
const EVENT_1 = "0e195b10-0000-7000-8000-000000000001";
const EVENT_2 = "0e195b10-0000-7000-8000-000000000002";
const EVENT_3 = "0e195b10-0000-7000-8000-000000000003";

function makeRecord(
  overrides: Partial<OutboxDeadLetterRecord> = {},
): OutboxDeadLetterRecord {
  return {
    event_id: EVENT_1,
    event_type: "audit.event.created",
    tenant_id: TENANT_A,
    store_id: null,
    delivery_state: "dead_lettered" as const,
    attempts: 8,
    correlation_id: null,
    last_error_class: "ConsumerTimeout",
    occurred_at: new Date("2026-05-19T10:00:00.123Z"),
    occurred_at_text: "2026-05-19T10:00:00.123456Z",
    created_at: new Date("2026-05-19T10:00:00.123Z"),
    updated_at: new Date("2026-05-19T11:30:00.000Z"),
    processed_at: new Date("2026-05-19T11:30:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  listDeadLettered.mockReset();
  getDeadLettered.mockReset();
});

// ===========================================================================
// constructor
// ===========================================================================
describe("OutboxAdminService — constructor", () => {
  it("constructs with an injected Pool reference", () => {
    const service = new OutboxAdminService(POOL_STUB);
    expect(service).toBeInstanceOf(OutboxAdminService);
  });
});

// ===========================================================================
// list — forwarding + paging
// ===========================================================================
describe("OutboxAdminService.list — repo input forwarding", () => {
  it("forwards no optional fields when the caller omits them", async () => {
    listDeadLettered.mockResolvedValue([]);
    const service = new OutboxAdminService(POOL_STUB);
    await service.list({ limit: 10 });
    expect(listDeadLettered).toHaveBeenCalledTimes(1);
    const [, input] = listDeadLettered.mock.calls[0]!;
    // CodeRabbit review on PR #240: `.toBeUndefined()` passes both
    // when the key is absent AND when it is present-but-undefined.
    // The "no undefined overspread" service contract requires actual
    // KEY ABSENCE (so the repo sees a clean object, not one littered
    // with `undefined` slots that the spread `{ ...maybe }` pattern
    // would otherwise leave behind). Assert ABSENCE via
    // `not.toHaveProperty`, which checks own-property existence.
    expect(input).not.toHaveProperty("eventType");
    expect(input).not.toHaveProperty("tenantId");
    expect(input).not.toHaveProperty("cursor");
    // Service requests limit + 1 to detect end-of-page in one round-trip.
    expect(input.limit).toBe(11);
  });

  it("forwards eventType when provided", async () => {
    listDeadLettered.mockResolvedValue([]);
    const service = new OutboxAdminService(POOL_STUB);
    await service.list({ limit: 10, eventType: "audit.event.created" });
    const [, input] = listDeadLettered.mock.calls[0]!;
    expect(input.eventType).toBe("audit.event.created");
  });

  it("forwards tenantId when provided", async () => {
    listDeadLettered.mockResolvedValue([]);
    const service = new OutboxAdminService(POOL_STUB);
    await service.list({ limit: 10, tenantId: TENANT_A });
    const [, input] = listDeadLettered.mock.calls[0]!;
    expect(input.tenantId).toBe(TENANT_A);
  });

  it("forwards the cursor's occurredAtText + eventId verbatim", async () => {
    listDeadLettered.mockResolvedValue([]);
    const service = new OutboxAdminService(POOL_STUB);
    await service.list({
      limit: 10,
      cursor: {
        occurredAtText: "2026-05-19T10:00:00.123456Z",
        eventId: EVENT_1,
      },
    });
    const [, input] = listDeadLettered.mock.calls[0]!;
    expect(input.cursor).toEqual({
      occurredAtText: "2026-05-19T10:00:00.123456Z",
      eventId: EVENT_1,
    });
  });
});

describe("OutboxAdminService.list — page envelope", () => {
  it("returns { items: [], next_cursor: null } on an empty page", async () => {
    listDeadLettered.mockResolvedValue([]);
    const service = new OutboxAdminService(POOL_STUB);
    const out = await service.list({ limit: 5 });
    expect(out.items).toEqual([]);
    expect(out.next_cursor).toBeNull();
  });

  it("returns next_cursor: null when the page is NOT full (hasMore = false)", async () => {
    // limit+1 fetched = 6, only 3 returned → no more pages.
    listDeadLettered.mockResolvedValue([
      makeRecord({ event_id: EVENT_1 }),
      makeRecord({ event_id: EVENT_2 }),
      makeRecord({ event_id: EVENT_3 }),
    ]);
    const service = new OutboxAdminService(POOL_STUB);
    const out = await service.list({ limit: 5 });
    expect(out.items).toHaveLength(3);
    expect(out.next_cursor).toBeNull();
  });

  it("returns a non-null next_cursor encoded from the LAST KEPT row's µs text", async () => {
    // limit=2; we ask the repo for 3; repo returns 3 → hasMore = true,
    // keep the first 2, build the cursor from row index 1 (the LAST
    // KEPT row, NOT the dropped sentinel row).
    const lastKept = makeRecord({
      event_id: EVENT_2,
      occurred_at_text: "2026-05-19T10:00:00.222222Z",
    });
    listDeadLettered.mockResolvedValue([
      makeRecord({ event_id: EVENT_1 }),
      lastKept,
      makeRecord({ event_id: EVENT_3 }), // the sentinel limit+1 row
    ]);
    const service = new OutboxAdminService(POOL_STUB);
    const out = await service.list({ limit: 2 });
    expect(out.items).toHaveLength(2);
    expect(out.next_cursor).toBe(
      encodeCursor(lastKept.occurred_at_text, lastKept.event_id),
    );
  });

  it("the cursor is built from occurred_at_text (µs), NEVER from occurred_at (ms)", async () => {
    // Regression guard: if a future refactor goes back to using
    // `last.occurred_at` (a JS Date), the cursor would carry the
    // millisecond-truncated ISO string. Decoded back through the
    // schema's OCCURRED_AT_TEXT_RE, that string would FAIL the
    // ".US"Z"" pattern -- but here we just verify the bytes match the
    // µs projection rather than the ms projection.
    const last = makeRecord({
      event_id: EVENT_2,
      occurred_at: new Date("2026-05-19T10:00:00.123Z"),
      occurred_at_text: "2026-05-19T10:00:00.123456Z",
    });
    listDeadLettered.mockResolvedValue([
      makeRecord({ event_id: EVENT_1 }),
      last,
      makeRecord({ event_id: EVENT_3 }),
    ]);
    const service = new OutboxAdminService(POOL_STUB);
    const out = await service.list({ limit: 2 });
    // Decode the produced cursor and confirm the µs digits are present.
    const decoded = Buffer.from(out.next_cursor!, "base64url").toString("utf8");
    expect(decoded).toContain("2026-05-19T10:00:00.123456Z");
    expect(decoded).not.toContain("2026-05-19T10:00:00.123Z|"); // the lossy form
  });

  it("the LAST item in the response is the LAST KEPT row, not the sentinel", async () => {
    const sentinel = makeRecord({ event_id: EVENT_3 });
    listDeadLettered.mockResolvedValue([
      makeRecord({ event_id: EVENT_1 }),
      makeRecord({ event_id: EVENT_2 }),
      sentinel,
    ]);
    const service = new OutboxAdminService(POOL_STUB);
    const out = await service.list({ limit: 2 });
    expect(out.items.map((i) => i.event_id)).toEqual([EVENT_1, EVENT_2]);
    expect(out.items.map((i) => i.event_id)).not.toContain(EVENT_3);
  });
});

// ===========================================================================
// list / get — DTO projection (toDto)
// ===========================================================================
describe("OutboxAdminService DTO projection", () => {
  it("projects Date columns through .toISOString() on the wire", async () => {
    listDeadLettered.mockResolvedValue([
      makeRecord({
        event_id: EVENT_1,
        occurred_at: new Date("2026-05-19T10:00:00.123Z"),
        created_at: new Date("2026-05-19T10:00:00.456Z"),
        updated_at: new Date("2026-05-19T11:30:00.000Z"),
        processed_at: new Date("2026-05-19T11:30:00.789Z"),
      }),
    ]);
    const service = new OutboxAdminService(POOL_STUB);
    const out = await service.list({ limit: 10 });
    const dto = out.items[0]!;
    expect(dto.occurred_at).toBe("2026-05-19T10:00:00.123Z");
    expect(dto.created_at).toBe("2026-05-19T10:00:00.456Z");
    expect(dto.updated_at).toBe("2026-05-19T11:30:00.000Z");
    expect(dto.processed_at).toBe("2026-05-19T11:30:00.789Z");
  });

  it("handles a nullable processed_at (returns null on the wire)", async () => {
    listDeadLettered.mockResolvedValue([
      makeRecord({ event_id: EVENT_1, processed_at: null }),
    ]);
    const service = new OutboxAdminService(POOL_STUB);
    const out = await service.list({ limit: 10 });
    expect(out.items[0]!.processed_at).toBeNull();
  });

  it("forwards last_error_class verbatim from the record (no re-sanitize)", async () => {
    // The repository already sanitises; the service trusts that contract.
    listDeadLettered.mockResolvedValue([
      makeRecord({ event_id: EVENT_1, last_error_class: "ConsumerTimeout" }),
    ]);
    const service = new OutboxAdminService(POOL_STUB);
    const out = await service.list({ limit: 10 });
    expect(out.items[0]!.last_error_class).toBe("ConsumerTimeout");
  });

  it("forwards a null last_error_class to the wire as null", async () => {
    listDeadLettered.mockResolvedValue([
      makeRecord({ event_id: EVENT_1, last_error_class: null }),
    ]);
    const service = new OutboxAdminService(POOL_STUB);
    const out = await service.list({ limit: 10 });
    expect(out.items[0]!.last_error_class).toBeNull();
  });

  it("never emits an `occurred_at_text` field on the DTO (internal only)", async () => {
    // The µs-precision field is for cursor construction inside the
    // service; clients never see it.
    listDeadLettered.mockResolvedValue([makeRecord({ event_id: EVENT_1 })]);
    const service = new OutboxAdminService(POOL_STUB);
    const out = await service.list({ limit: 10 });
    expect(Object.keys(out.items[0]!)).not.toContain("occurred_at_text");
  });

  it("never emits a `payload` field on the DTO (allowlist completeness)", async () => {
    listDeadLettered.mockResolvedValue([makeRecord({ event_id: EVENT_1 })]);
    const service = new OutboxAdminService(POOL_STUB);
    const out = await service.list({ limit: 10 });
    expect(Object.keys(out.items[0]!)).not.toContain("payload");
  });

  it("the DTO key set matches the allowlist exactly", async () => {
    listDeadLettered.mockResolvedValue([makeRecord({ event_id: EVENT_1 })]);
    const service = new OutboxAdminService(POOL_STUB);
    const out = await service.list({ limit: 10 });
    expect(new Set(Object.keys(out.items[0]!))).toEqual(
      new Set([
        "event_id",
        "event_type",
        "tenant_id",
        "store_id",
        "delivery_state",
        "attempts",
        "correlation_id",
        "last_error_class",
        "occurred_at",
        "created_at",
        "updated_at",
        "processed_at",
      ]),
    );
  });
});

// ===========================================================================
// get
// ===========================================================================
describe("OutboxAdminService.get", () => {
  it("returns the projected DTO when the repository finds a row", async () => {
    getDeadLettered.mockResolvedValue(
      makeRecord({ event_id: EVENT_1, last_error_class: "ConsumerTimeout" }),
    );
    const service = new OutboxAdminService(POOL_STUB);
    const out = await service.get(EVENT_1);
    expect(out).not.toBeNull();
    expect(out!.event_id).toBe(EVENT_1);
    expect(out!.delivery_state).toBe("dead_lettered");
    expect(out!.last_error_class).toBe("ConsumerTimeout");
  });

  it("returns null when the repository returns null", async () => {
    getDeadLettered.mockResolvedValue(null);
    const service = new OutboxAdminService(POOL_STUB);
    const out = await service.get(EVENT_1);
    expect(out).toBeNull();
  });

  it("forwards the eventId verbatim to the repository", async () => {
    getDeadLettered.mockResolvedValue(null);
    const service = new OutboxAdminService(POOL_STUB);
    await service.get(EVENT_1);
    expect(getDeadLettered).toHaveBeenCalledWith(POOL_STUB, EVENT_1);
  });

  it("never emits a `payload` field on the detail DTO", async () => {
    getDeadLettered.mockResolvedValue(makeRecord({ event_id: EVENT_1 }));
    const service = new OutboxAdminService(POOL_STUB);
    const out = await service.get(EVENT_1);
    expect(Object.keys(out!)).not.toContain("payload");
  });

  it("propagates a nullable processed_at on the detail DTO", async () => {
    getDeadLettered.mockResolvedValue(
      makeRecord({ event_id: EVENT_1, processed_at: null }),
    );
    const service = new OutboxAdminService(POOL_STUB);
    const out = await service.get(EVENT_1);
    expect(out!.processed_at).toBeNull();
  });
});
