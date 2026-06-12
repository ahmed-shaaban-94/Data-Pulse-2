/**
 * sale-sync-deadletter.spec.ts — 032 §8 / US4 (T027, T028, T029).
 *
 * Docker-free coverage for the dead-letter classifier (T029) and the
 * NEEDS_REPAIR / RETRYABLE quarantine producer (T030):
 *   - T027: a non-retryable failure (validation) -> a 'needs-repair' row in
 *     sale_sync_deadletters, provenance intact, status advanced to
 *     failed-needs-repair, never a silent drop.
 *   - T028: a transient/5xx failure -> 'retryable' with the failed-retryable
 *     status; the reconnect-auth-failure case routes to the 028 OQ-5
 *     classification (bound by reference — authOwnedBy028 + oq5Escalation),
 *     NOT re-decided here.
 *   - T029: the classifier vocabulary is PINNED to the §7/§8 spec values + the
 *     0026 CHECK constraint literals.
 *
 * `runWithTenantContext` is mocked to invoke its callback with a scripted
 * client, so the producer runs entirely in-process with NO database — the same
 * Docker-free seam `apps/api/test/catalog/sale-sync-ops/sale-sync-ops.unit.spec`
 * uses. The TRUE RLS / partial-unique / composite-FK behavior over real
 * Postgres is a Testcontainers concern and CANNOT run in this environment (no
 * Docker); it is NOT asserted here and is NOT faked.
 */

// Mock @data-pulse-2/db so runWithTenantContext invokes the callback with a
// scripted client (no real connection / transaction).
let clientQuery: jest.Mock;
jest.mock("@data-pulse-2/db", () => ({
  runWithTenantContext: (
    _pool: unknown,
    _ctx: unknown,
    fn: (c: { query: jest.Mock }) => unknown,
  ) => fn({ query: clientQuery }),
}));

import {
  SYNC_FAILURE_CONDITION,
  SYNC_STATUS_FAILED_NEEDS_REPAIR,
  SYNC_STATUS_FAILED_RETRYABLE,
  classifySyncFailure,
} from "../../src/sales/sale-sync-failure-classifier";
import {
  SaleSyncDeadletterProducer,
  QuarantineSaleNotFoundError,
} from "../../src/sales/sale-sync-deadletter.producer";

// Hex-only UUID literals (memory: restrict mnemonic prefixes to a-f).
const TENANT = "5a1e0000-0000-7000-8000-0000000000a1";
const STORE = "5a1e0000-0000-7000-8000-0000000000b1";
const SALE = "5a1e0000-0000-7000-8000-0000000000d1";

const baseInput = {
  saleId: SALE,
  tenantId: TENANT,
  storeId: STORE,
  sourceSystem: "pos-x",
  externalId: "ext-1",
} as const;

describe("032 §8 — dead-letter classifier (T029)", () => {
  it("classifies validation failure as NEEDS_REPAIR (DP-2-owned, no 028 binding)", () => {
    const c = classifySyncFailure(SYNC_FAILURE_CONDITION.VALIDATION_FAILURE);
    expect(c.classification).toBe("needs-repair");
    expect(c.syncStatus).toBe(SYNC_STATUS_FAILED_NEEDS_REPAIR);
    expect(c.reasonCode).toBe("validation_failure");
    expect(c.authOwnedBy028).toBe(false);
    expect(c.oq5Escalation).toBe(false);
  });

  it("classifies transient/5xx as RETRYABLE (DP-2-owned backoff)", () => {
    const c = classifySyncFailure(SYNC_FAILURE_CONDITION.TRANSIENT);
    expect(c.classification).toBe("retryable");
    expect(c.syncStatus).toBe(SYNC_STATUS_FAILED_RETRYABLE);
    expect(c.reasonCode).toBe("transient_5xx");
    expect(c.authOwnedBy028).toBe(false);
  });

  it("classifies 401 auth-invalid as RETRYABLE bound to 028 (G10), no OQ-5 escalation", () => {
    const c = classifySyncFailure(SYNC_FAILURE_CONDITION.AUTH_INVALID);
    expect(c.classification).toBe("retryable");
    expect(c.authOwnedBy028).toBe(true);
    expect(c.oq5Escalation).toBe(false);
  });

  it("routes 403 forbidden + reconnect-auth-failure to the 028 OQ-5 classification (not re-decided)", () => {
    for (const cond of [
      SYNC_FAILURE_CONDITION.FORBIDDEN,
      SYNC_FAILURE_CONDITION.RECONNECT_AUTH_FAILURE,
    ]) {
      const c = classifySyncFailure(cond);
      // Bound by reference: RETRYABLE now, persistent->NEEDS_REPAIR is the OPEN
      // 028 OQ-5 owner decision — flagged, never acted on here (no persistence
      // tracker; encoding it would re-decide auth, G10 violation).
      expect(c.classification).toBe("retryable");
      expect(c.syncStatus).toBe(SYNC_STATUS_FAILED_RETRYABLE);
      expect(c.authOwnedBy028).toBe(true);
      expect(c.oq5Escalation).toBe(true);
    }
  });

  it("PINS the failure-status literals to the §7/§8 + 0026 CHECK vocabulary", () => {
    // The worker keeps a LOCAL copy of these (no cross-app import); this pin is
    // the guard against drift from the api-side sale-sync-status.ts + the
    // sales_sync_status_valid / sale_sync_deadletters_classification_valid CHECK.
    expect(SYNC_STATUS_FAILED_RETRYABLE).toBe("failed-retryable");
    expect(SYNC_STATUS_FAILED_NEEDS_REPAIR).toBe("failed-needs-repair");
  });
});

describe("032 §8 — quarantine producer (T027 non-retryable)", () => {
  beforeEach(() => {
    clientQuery = jest.fn();
  });

  it("writes a needs-repair row with provenance intact + advances status (never a silent drop)", async () => {
    clientQuery
      // 1. object-safety read → sale in scope
      .mockResolvedValueOnce({ rows: [{ id: SALE }] })
      // 2. deadletter INSERT → fresh row
      .mockResolvedValueOnce({ rows: [{ id: "dl1" }] })
      // 3. sales status UPDATE → advanced
      .mockResolvedValueOnce({ rows: [{ id: SALE }] });

    const producer = new SaleSyncDeadletterProducer({} as never);
    const result = await producer.quarantine({
      ...baseInput,
      condition: SYNC_FAILURE_CONDITION.VALIDATION_FAILURE,
    });

    expect(result.quarantined).toBe(true);
    expect(result.statusAdvanced).toBe(true);
    expect(result.classification.classification).toBe("needs-repair");

    // Provenance preserved on the INSERT (028): source_system + external_id are
    // passed through unchanged, never dropped.
    const insertCall = clientQuery.mock.calls[1];
    expect(insertCall[0]).toMatch(/INSERT INTO sale_sync_deadletters/);
    expect(insertCall[1]).toEqual(
      expect.arrayContaining(["pos-x", "ext-1", "needs-repair", "validation_failure"]),
    );
    // The INSERT is idempotent against the OPEN-row partial-unique index.
    expect(insertCall[0]).toMatch(/ON CONFLICT \(sale_id\) WHERE resolved_at IS NULL/);

    // No raw payload / money / line amounts are present anywhere in the SQL args.
    for (const call of clientQuery.mock.calls) {
      const sqlText: string = call[0];
      expect(sqlText).not.toMatch(/pos_total|line_amount|payload/i);
    }
  });

  it("is idempotent — a re-delivery hitting the open-row conflict is a no-op insert", async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: SALE }] }) // in scope
      .mockResolvedValueOnce({ rows: [] }) // INSERT ... DO NOTHING → no row
      .mockResolvedValueOnce({ rows: [{ id: SALE }] }); // status still set

    const producer = new SaleSyncDeadletterProducer({} as never);
    const result = await producer.quarantine({
      ...baseInput,
      condition: SYNC_FAILURE_CONDITION.VALIDATION_FAILURE,
    });
    expect(result.quarantined).toBe(false);
    expect(result.classification.classification).toBe("needs-repair");
  });

  it("throws QuarantineSaleNotFoundError for an absent/out-of-scope sale (no write)", async () => {
    clientQuery.mockResolvedValueOnce({ rows: [] }); // not in scope
    const producer = new SaleSyncDeadletterProducer({} as never);
    await expect(
      producer.quarantine({
        ...baseInput,
        condition: SYNC_FAILURE_CONDITION.VALIDATION_FAILURE,
      }),
    ).rejects.toBeInstanceOf(QuarantineSaleNotFoundError);
    // Only the object-safety read ran — no INSERT, no UPDATE.
    expect(clientQuery).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed saleId before opening a connection", async () => {
    const producer = new SaleSyncDeadletterProducer({} as never);
    await expect(
      producer.quarantine({
        ...baseInput,
        saleId: "not-a-uuid",
        condition: SYNC_FAILURE_CONDITION.VALIDATION_FAILURE,
      }),
    ).rejects.toThrow(/saleId must be a UUID/);
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it.each([
    ["tenantId", { tenantId: "nope" }, /tenantId must be a UUID/],
    ["storeId", { storeId: "nope" }, /storeId must be a UUID/],
    ["sourceSystem", { sourceSystem: "" }, /sourceSystem must be a non-empty/],
    ["externalId", { externalId: "" }, /externalId must be a non-empty/],
  ])(
    "rejects a malformed %s before opening a connection",
    async (_label, override, matcher) => {
      const producer = new SaleSyncDeadletterProducer({} as never);
      await expect(
        producer.quarantine({
          ...baseInput,
          ...(override as Record<string, string>),
          condition: SYNC_FAILURE_CONDITION.VALIDATION_FAILURE,
        }),
      ).rejects.toThrow(matcher as RegExp);
      expect(clientQuery).not.toHaveBeenCalled();
    },
  );

  it("rethrows without a logger present (logger is optional)", async () => {
    const err = new Error("kaboom");
    clientQuery.mockRejectedValueOnce(err);
    // No logger injected — the optional-chaining `logger?.error` is a no-op.
    const producer = new SaleSyncDeadletterProducer({} as never);
    await expect(
      producer.quarantine({
        ...baseInput,
        condition: SYNC_FAILURE_CONDITION.VALIDATION_FAILURE,
      }),
    ).rejects.toBe(err);
  });
});

describe("032 §8 — quarantine producer (T028 transient + 028 OQ-5)", () => {
  beforeEach(() => {
    clientQuery = jest.fn();
  });

  it("transient/5xx → failed-retryable row + status (backoff class)", async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: SALE }] })
      .mockResolvedValueOnce({ rows: [{ id: "dl1" }] })
      .mockResolvedValueOnce({ rows: [{ id: SALE }] });

    const producer = new SaleSyncDeadletterProducer({} as never);
    const result = await producer.quarantine({
      ...baseInput,
      condition: SYNC_FAILURE_CONDITION.TRANSIENT,
    });
    expect(result.classification.classification).toBe("retryable");
    expect(result.classification.syncStatus).toBe(SYNC_STATUS_FAILED_RETRYABLE);

    const updateCall = clientQuery.mock.calls[2];
    expect(updateCall[0]).toMatch(/UPDATE sales/);
    // The status advance must NOT clobber a concurrently-synced sale.
    expect(updateCall[0]).toMatch(/sync_status <> \$4/);
    expect(updateCall[1]).toContain("synced");
    expect(updateCall[1]).toContain(SYNC_STATUS_FAILED_RETRYABLE);
  });

  it("reconnect-auth-failure quarantines as 028-OQ-5-bound retryable (not re-decided)", async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: SALE }] })
      .mockResolvedValueOnce({ rows: [{ id: "dl1" }] })
      .mockResolvedValueOnce({ rows: [{ id: SALE }] });

    const producer = new SaleSyncDeadletterProducer({} as never);
    const result = await producer.quarantine({
      ...baseInput,
      condition: SYNC_FAILURE_CONDITION.RECONNECT_AUTH_FAILURE,
    });
    expect(result.classification.authOwnedBy028).toBe(true);
    expect(result.classification.oq5Escalation).toBe(true);
    expect(result.classification.classification).toBe("retryable");
  });

  it("does not advance status when the sale is already synced (no clobber); still logs nothing sensitive", async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [{ id: SALE }] }) // in scope
      .mockResolvedValueOnce({ rows: [{ id: "dl1" }] }) // deadletter written
      .mockResolvedValueOnce({ rows: [] }); // UPDATE guarded out (already synced)

    const producer = new SaleSyncDeadletterProducer({} as never);
    const result = await producer.quarantine({
      ...baseInput,
      condition: SYNC_FAILURE_CONDITION.TRANSIENT,
    });
    expect(result.quarantined).toBe(true);
    expect(result.statusAdvanced).toBe(false);
  });

  it("logs only identifiers + error class on failure (no payload), then rethrows", async () => {
    const err = new Error("boom");
    clientQuery.mockRejectedValueOnce(err); // object-safety read throws
    const logger = { error: jest.fn() };
    const producer = new SaleSyncDeadletterProducer({} as never, logger);
    await expect(
      producer.quarantine({
        ...baseInput,
        condition: SYNC_FAILURE_CONDITION.TRANSIENT,
      }),
    ).rejects.toBe(err);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const logged = logger.error.mock.calls[0][0] as Record<string, unknown>;
    expect(logged).toMatchObject({
      job_name: "sale-sync-quarantine",
      sale_id: SALE,
      error_class: "Error",
    });
    // No payload / money keys leaked into the log object.
    expect(Object.keys(logged)).not.toContain("pos_total");
    expect(Object.keys(logged)).not.toContain("payload");
  });
});
