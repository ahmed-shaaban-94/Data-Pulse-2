# Self-Review — 020 Connector Health and Connection-Status API

Final review of the planning artifact set (spec / plan / research / data-model / tasks / analysis). Date: 2026-06-07.

## Does it honor the constitution?

Yes. All touched principles (II, III, IV, V, IX, X, XI, XII, XIV) PASS in the plan's Constitution Check. The single deviation — last-write-wins on the `connector_health` row instead of the §III-preferred optimistic concurrency — is explicitly justified (monotonic observational data, no corruptible invariant) and recorded in plan Complexity Tracking, exactly as §III requires. Multi-tenant RLS (fail-closed CASE, runtime role never BYPASSRLS), safe-404 cross-tenant non-disclosure, mass-assignment ban (identity from the 018 guard, never the body), server-clock liveness (§X), no-money/no-PII (§XIV), and contract-first prose-only are all carried through to the tasks.

## Does it stay no-implement?

Yes. Only seven markdown artifacts were authored, all under `specs/020-connector-health-and-connection-status-api/`. No application code, schema, migration, or contract was written. The future source layout is described as a TARGET only.

## Does it avoid gated surfaces?

Yes. No file under `packages/contracts/openapi/**`, `packages/db/drizzle/**`, `packages/db/src/schema/**`, `.github/**`, `package.json`, or `pnpm-lock.yaml` was created or edited. The new `connector_health` schema/migration and the new `connector-health.yaml` contract are described in prose and flagged `[GATED]` in tasks T003/T004/T006; nothing gated was authored. The script's `git checkout -b` is the only git write, performed internally by `create-new-feature.ps1` inside the isolated worktree.

## Is it a coherent, buildable spec?

Yes. Three independently testable user stories with P1 (operator read) as a genuine standalone MVP that delivers value before the P2 heartbeat exists (`never_seen`). Every FR maps to at least one task; every story and SC is traceable (analysis.md coverage table). The auth model reuses 018's exact guards (no new primitive), the read-model is one clean table FK'd to 018 identity, and the verdict is a pure read-time function (no worker needed in v1). The arc boundary (no outbound ERPNext) is asserted in spec, plan, research, data-model, and a dedicated test task (T022).

## Residual risks

1. **(MEDIUM, F4)** No v1 metric proactively detects a connector going dark — per-instance dark-detection is operator-poll-only; proactive alerting is the named scheduled-sweep follow-up. A reviewer expecting alerting must be told it is deferred (it is, in spec assumptions + research D9).
2. **(LOW)** Two gated-surface decisions (signal shape Q6, contract placement Q7) were auto-resolved rather than human-confirmed; both are reversible at gate-approval time and the rationale is recorded in research D6/D7.
3. **(LOW)** Migration number is a placeholder (`00NN`, expected `0022`) pending `main` state at gate time.
4. **(LOW)** The `connector_health.tenant_id` = registration consistency is app-enforced (guard + RLS) in v1, not a DB CHECK — consistent with 018's own deferred-CHECK precedent.

## Single recommended next action

Submit the planning chain for human gate review of the two `[GATED]` surfaces (the `connector_health` schema/migration and the new `connector-health.yaml` contract). On approval, dispatch the Foundational phase (T003-T006) first, then the P1 MVP (T009-T016) as the first shippable slice.
