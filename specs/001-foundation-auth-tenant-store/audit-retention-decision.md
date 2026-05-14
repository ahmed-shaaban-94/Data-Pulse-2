# Audit Log Retention Policy — Decision Record

**Feature**: 001-foundation-auth-tenant-store
**Decision type**: Foundation policy + future-implementation contract
**Status**: Accepted (this document IS the decision)
**Date**: 2026-05-14
**Author**: T311 unblocking pass
**Counterparts**:
- Task: `tasks.md` T311
- Spec: `spec.md` SC-7, FR-AUDIT-1/2/3
- Verification: `sc-verification.md` SC-7 (currently Partial — this doc unblocks it for future implementation)
- Constitution: §XIII Auditability & Provenance, §XIV PII & Data Lifecycle Discipline

---

## 1. Problem statement

SC-7 requires that "100% of role/permission/access changes are retrievable from
the audit log per tenant for at least the documented retention period." The
retention period was never documented, which means the "at least the documented
retention period" clause of SC-7 cannot be verified regardless of how complete
the audit capture implementation is. T311 has been blocked in `tasks.md` since
the foundation was delivered because no policy existed to implement against; this
document resolves that blocker by committing the policy and the future
implementation contract.

---

## 2. Current blockers (resolved by this document)

| # | Blocker | Resolution |
|---|---------|-----------|
| B1 | No documented retention period for `audit_events` rows | **Decided here: 365 days from `occurred_at`** |
| B2 | No `audit_events` column to mark records past retention | **Decided here: add `retention_marked_at timestamptz null` in a future migration** |
| B3 | Worker pattern for scheduled sweep not yet wired into the audit module | Out of scope for this decision — implementation concern for the future T311 PR |

---

## 3. Decision summary

- **Retention window**: 365 days from `audit_events.occurred_at`.
- **Retention action**: mark-only. No deletion of audit rows in this foundation.
- **Future schema column**: `audit_events.retention_marked_at timestamptz null`.
- **Worker behavior**: scheduled worker finds rows where
  `occurred_at < now() - interval '365 days'` AND `retention_marked_at IS NULL`,
  then sets `retention_marked_at = now()`.
- **Immutability boundary**: audit facts (the columns the application writes on
  INSERT) remain immutable; only the dedicated retention worker may set the
  lifecycle marker `retention_marked_at`. The API role keeps its INSERT-only
  access; the worker uses a separate role/grant for the UPDATE (see §8 for the
  current baseline and the future target).

---

## 4. Retention window — why 365 days

365 days is the foundation-level baseline for audit log retention. Most
jurisdictions require one year or more for security audit logs that record
administrative actions (role/permission changes, cross-tenant access, platform
admin operations). One year also provides reasonable coverage for retail
seasonal cycles and is small enough that storage cost remains manageable (see
§12 risk table). This is a baseline; tenants operating under stricter regulatory
requirements (PCI-DSS Level 1, SOC 2 Type II, GDPR-adjacent national law) can
elect a longer retention window via a future tenant-level override, which is an
explicit non-goal of this foundation decision.

---

## 5. Retention action — why mark-only

Constitution §XIII states that the application layer MUST NOT update or delete
audit records — "retention sweeps run as privileged platform operations under a
documented procedure." Mark-only satisfies this: it adds a lifecycle marker to
the row without touching any audit fact column, and it preserves every row so
legal-hold, compliance-export, and future policy changes (e.g., extend window
from 365 to 730 days) can act on already-marked rows without loss. Deleting
audit rows in the foundation would create an irreversible tampering surface that
the spec does not require and that §XIII explicitly prohibits at the application
layer. A future "audit hard delete" workflow that consumes `retention_marked_at`
as a deletion-readiness flag is out of scope for this foundation; if that flow
is needed, it ships as its own approved PR with audit-of-audit semantics.

---

## 6. Future schema column

```sql
-- Future migration (NOT part of this PR):
ALTER TABLE audit_events
  ADD COLUMN retention_marked_at TIMESTAMPTZ NULL;

-- Partial index on marked rows — keeps queries that consume the marker
-- (legal hold, export, eventual delete sweep) fast; the worker's own
-- predicate (IS NULL) benefits from the occurred_at index.
CREATE INDEX audit_events_retention_marked_at_idx
  ON audit_events (retention_marked_at)
  WHERE retention_marked_at IS NOT NULL;
```

The column is nullable with no default. `NULL` means "not yet evaluated" — the
worker's predicate `WHERE occurred_at < now() - interval '365 days' AND
retention_marked_at IS NULL` relies on this natural three-state encoding (not yet
reached retention age / reached retention age but not yet swept / swept). The
partial index covers queries that look for already-marked rows (legal hold checks,
export jobs, a future deletion sweep); those queries are structurally different
from the sweep worker's predicate, so the two access patterns complement rather
than duplicate each other.

---

## 7. Worker behavior (future)

The future T311 worker is a BullMQ repeatable job registered in
`apps/worker/src/worker.module.ts` with a daily cadence. A daily schedule is
more than sufficient for a 365-day window — missing one run by hours does not
materially change the marked set. The processor at
`apps/worker/src/audit/audit-retention.processor.ts` follows the layered
architecture already established by `audit-fanout.processor.ts` (Layer A: pure
business logic; Layer B: BullMQ wiring deferred to the same PR):

**Pseudocode (non-normative — the actual implementation belongs in the T311 PR):**

```
async sweepBatch(batchSize: number = 1000): Promise<number> {
  const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  // One UPDATE per batch; COMMIT after each batch to keep transactions short.
  const result = await db
    .update(audit_events)
    .set({ retention_marked_at: new Date() })
    .where(
      and(
        lt(audit_events.occurred_at, cutoff),
        isNull(audit_events.retention_marked_at),
      )
    )
    .limit(batchSize)
    .returning({ id: audit_events.id });
  return result.length;
}

async process(): Promise<void> {
  const correlationId = newId();
  let totalMarked = 0;
  let batch: number;
  do {
    batch = await this.sweepBatch(BATCH_SIZE);
    totalMarked += batch;
  } while (batch === BATCH_SIZE);

  logger.info({
    event: 'audit_retention_sweep.complete',
    correlation_id: correlationId,
    rows_marked: totalMarked,
    cutoff_days: 365,
  });
}
```

Key properties:
- **Idempotent by predicate**: the `IS NULL` filter ensures a re-run marks
  exactly the same rows that would have been marked by a single successful run,
  with no double-updates.
- **Batched transactions**: one `UPDATE … LIMIT 1000` per batch keeps individual
  transactions short and avoids long-hold lock contention on the `audit_events`
  table.
- **No tenant context required for the sweep itself**: `audit_events` rows with
  `tenant_id IS NULL` (platform events) are also eligible; the worker uses the
  migration/privileged role (see §8) which bypasses RLS for this specific UPDATE,
  consistent with §XIII's "privileged platform operation" framing.
- **Structured log per run**: one pino log line with `correlation_id`,
  `rows_marked`, and `cutoff_days` for CI artifact capture and operational
  monitoring.
- **`correlationId` propagation**: carried in the BullMQ job payload per
  Constitution §V (every job carries `correlationId`).

The pattern follows `apps/worker/src/audit/audit-fanout.processor.ts` (the
Layer-A / Layer-B split) and is comparable to the soft-delete sweep at
`apps/worker/src/cleanup/soft-delete-sweep.processor.ts` (T312).

---

## 8. Immutability boundary (security-critical)

**Current baseline (foundation as shipped)**: The `audit_events` table has no
explicit `GRANT UPDATE` in `packages/db/drizzle/0000_initial.sql`. The file
ends after RLS policies with no GRANT statements, meaning the application's
runtime Postgres role does not hold UPDATE privilege on `audit_events` by
default. The insert-only posture is enforced today by (a) Postgres default-deny
on UPDATE, (b) the application-layer insert-only discipline asserted by test
T237, and (c) the Constitution §XIII prohibition on application-layer updates.

**Future target (T311 PR)**: The future migration adds `retention_marked_at` and
must also establish explicit DB-layer role separation:

- The **API application role** continues to hold `INSERT` on `audit_events` only.
  It MUST NOT receive `UPDATE` on `audit_events` (not even restricted to the
  new column).
- The **retention worker** uses a separate Postgres role (or the migration/
  privileged role under a tightly scoped `GRANT UPDATE (retention_marked_at) ON
  audit_events TO <worker_role>`) that can set `retention_marked_at` and no other
  column.
- **No role** — application, worker, or otherwise — holds `DELETE` on
  `audit_events`. Delete privilege is reserved for an explicit, audited platform
  operation that does not exist in this foundation.

The future T311 PR's DB-layer test
(`packages/db/__tests__/audit-retention.invariant.spec.ts`) MUST assert: (a) the
API role cannot UPDATE `retention_marked_at`; (b) the worker role can; (c) no
role can DELETE `audit_events` rows.

---

## 9. Why the foundation does not delete audit rows

Constitution §XIII is explicit: "The application layer MUST NOT update or delete
audit records." A future "audit hard delete" workflow may consume the
`retention_marked_at` flag as a deletion-readiness signal, but it requires its
own spec and approved PR with audit-of-audit semantics. Deleting rows in the
foundation would create a tampering risk surface and would conflict with §XIV's
right-to-erasure guidance, which specifies that audit records MAY remain with
PII fields tombstoned rather than the row deleted.

---

## 10. Future implementation checklist

A future PR titled something like `feat(audit): implement retention sweep (T311)`
MUST include:

- [ ] Numbered SQL migration adding `retention_marked_at` column + partial index on `audit_events`
- [ ] Drizzle schema update for `packages/db/src/schema/audit_events.ts`
- [ ] Updated `audit_events` RLS policy (if necessary) to allow worker UPDATE on `retention_marked_at` while preserving API INSERT-only; explicit `GRANT UPDATE (retention_marked_at)` scoped to the worker role
- [ ] DB-layer test at `packages/db/__tests__/audit-retention.invariant.spec.ts` asserting: API role cannot UPDATE `retention_marked_at`; worker role can; no role can DELETE `audit_events` rows
- [ ] Worker processor at `apps/worker/src/audit/audit-retention.processor.ts`
- [ ] Worker tests at `apps/worker/test/audit/retention.spec.ts` (the path called out in `tasks.md` T311)
- [ ] Wire-up in `apps/worker/src/worker.module.ts`
- [ ] BullMQ schedule registration (cadence: daily)
- [ ] Structured log line emitted per sweep run for CI artifact capture (per §7)
- [ ] `sc-verification.md` update promoting SC-7 from Partial to Verified once the worker test runs green in CI

---

## 11. Non-goals

- This decision does NOT implement T311 — the implementation PR is separate and
  must follow the checklist in §10.
- This decision does NOT delete audit rows.
- This decision does NOT add a tenant-level retention override (deferred to a
  future feature if needed).
- This decision does NOT change `tasks.md`, `sc-verification.md`, or `spec.md`.
- This decision does NOT add a SQL migration, Drizzle schema change, or any
  production source file.

---

## 12. Risks and follow-up decisions

| Risk | Mitigation |
|------|-----------|
| Regulatory environment may require longer retention | 365 days is the FOUNDATION default; a future tenant-level override is the escape hatch. This default is explicitly noted as revisable in the future implementation PR. |
| Storage growth at 365 days | Audit row size is small (~500 bytes typical); 1M events/year/tenant ≈ 500 MB — manageable without partitioning. Monthly partitioning of `audit_events` by `occurred_at` is a future optimization, not foundation scope (see constitution Sync Impact Report: "Decide audit-event storage destination growth strategy once retention pressure surfaces"). |
| `retention_marked_at` becomes a deletion-readiness flag without an actual delete workflow | Intentional — a future "audit delete" workflow can consume this flag, but is out of foundation scope and requires its own spec and approved PR. |
| Worker missing a day | The sweep predicate is idempotent (`retention_marked_at IS NULL`); the next daily run catches all rows missed by any prior gap without duplication. |
| Privileged role grant scope creep | The future T311 PR MUST scope the UPDATE grant to the `retention_marked_at` column only (column-level privilege), not to the entire `audit_events` table. The DB-layer invariant test enforces this. |

---

## 13. References

- Task: `tasks.md` T311
- Spec: `spec.md` SC-7, FR-AUDIT-1/2/3
- Verification: `sc-verification.md` §SC-7 (Partial — this doc unblocks final verification after future implementation)
- Constitution: `.specify/memory/constitution.md` §XIII Auditability & Provenance, §XIV PII & Data Lifecycle Discipline
- Current schema: `packages/db/src/schema/audit_events.ts`, `packages/db/drizzle/0000_initial.sql`
- Existing worker pattern: `apps/worker/src/audit/audit-fanout.processor.ts`
- Comparable sweep pattern: `apps/worker/src/cleanup/soft-delete-sweep.processor.ts` (T312)
- Existing worker test examples: `apps/worker/test/audit/audit-fanout.processor.spec.ts`, `apps/worker/test/cleanup/soft-delete-sweep.spec.ts`

---

End of decision record.
