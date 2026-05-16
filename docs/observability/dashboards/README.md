# Dashboards (placeholder)

**Ref**: 004-platform-production-readiness (T450)
**Date**: 2026-05-16
**Status**: **Placeholder.** No dashboards are generated, committed, or
deployed by this PR.

---

## Dashboards-as-code policy

Dashboards (Grafana JSON, OpenTelemetry Collector pipeline configs,
managed-vendor dashboard exports) live in a **separate `ops/` repository**,
**not** in this monorepo.

Rationale:

- **Separation of concerns.** This monorepo is the source of truth for
  the platform's *signals* (see `../signals.md`). Dashboards are a
  *consumer* of those signals. Mixing them in one repo couples release
  cadence and review boundaries that should remain independent.
- **Vendor neutrality (FR-B-007).** Dashboards-as-code in the `ops/` repo
  can target whichever observability stack the platform deploys against
  (OTel Collector + Grafana, Prometheus + Grafana, or a managed vendor)
  without forcing this repo to take on vendor-specific JSON schemas.
- **Gating discipline (plan §5).** No CI workflow changes in this PR; no
  `package.json` additions for dashboard tooling (`grafonnet`,
  `terraform-grafana-provider`, etc.). Dashboards-as-code tooling lives
  with the dashboards themselves, in `ops/`.

---

## No dashboards in this PR

This PR (Track B P3 documentation slice) authors the signal catalogue
and the redaction policy only. No `.json`, no `.jsonnet`, no `.yaml`,
and no rendered dashboard images are committed to this repo by this
slice. A subsequent gated PR (Track B P4 instrumentation slice) will
make the signals *available* at the `/metrics` endpoint and via OTel
exports; dashboard authoring against those signals happens in `ops/`
after P4 ships.

---

## Future dashboards expected

The following dashboards are anticipated in `ops/` once their underlying
signals are emitted. Every dashboard MUST source its panels from the
named signals in [`../signals.md`](../signals.md); ad-hoc query strings
that drift from the catalogue are a defect.

| Dashboard | Source signals (from `../signals.md`) | Available after slice |
|---|---|---|
| **API SLOs** | `http_request_count`, `http_request_duration_seconds` (p95/p99), `http_error_4xx_total`, `http_error_5xx_total`, `auth_failure_total`, `tenant_context_failure_total`, `validation_failure_total`, `cross_tenant_rejection_total` | P4 (Track B instrumentation) |
| **DB pool & RLS** | `db_pool_in_use`, `db_pool_waiters`, `db_slow_query_total`, `db_rls_context_failure_total`, `db_migration_status` | P4 |
| **Worker / queue** | `redis_command_duration_seconds`, `queue_lag_seconds`, `queue_failed_total`, `queue_dead_letter_total`, `queue_retry_total`, `worker_job_duration_seconds`, `worker_processing_failure_total` | P4 |
| **Outbox** | `outbox_pending_total`, `outbox_dead_letter_total`, `outbox_drain_duration_seconds` | After Track C P7 (outbox first slice) |
| **Idempotency** | `idempotency_replay_total`, `idempotency_conflict_total`, `idempotency_in_progress_total` | After Track D first slice |

The dashboards above are **expectations**, not commitments. Each
dashboard ships in `ops/` under its own change-control discipline; this
README does not bind a delivery date.

---

## Cross-references

- **Signal catalogue (source of truth for names)**: [`../signals.md`](../signals.md)
- **Alert rules (also `ops/`-resident)**: [`../alerts/README.md`](../alerts/README.md)
- **Redaction policy (source of truth for log-boundary safety)**:
  [`../../.specify/memory/redaction-matrix.md`](../../.specify/memory/redaction-matrix.md)

---

## What this README is **not**

- Not a dashboard.
- Not a manifest pointing at hidden dashboard files in this repo
  (there are none).
- Not authorization for `ops/` to land in this monorepo as a folder.
- Not a vendor selection.

---

*End of dashboards placeholder.*
