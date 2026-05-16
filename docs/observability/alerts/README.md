# Alerts (placeholder)

**Ref**: 004-platform-production-readiness (T451)
**Date**: 2026-05-16
**Status**: **Placeholder.** No alerts are generated, committed, or
deployed by this PR.

---

## Alerts-as-code policy

Alert rules (Prometheus `alerting_rules.yaml`, Grafana alert provisioning,
OpenTelemetry Collector pipeline alert routes, managed-vendor alert
exports) live in the **same `ops/` repository** as dashboards (see
[`../dashboards/README.md`](../dashboards/README.md)). They are **not**
authored in this monorepo.

Rationale:

- **Co-location with dashboards.** Alerts and dashboards share the same
  signal source-of-truth ([`../signals.md`](../signals.md)) and the same
  vendor-neutral target stack. They share a review boundary, a release
  cadence, and an on-call handoff path.
- **Vendor neutrality (FR-B-007).** The platform may target OTel
  Collector + Alertmanager, Prometheus + Alertmanager, or a managed
  vendor's alert engine. Alerts-as-code in `ops/` swap rendering targets
  without rebooting this repo.
- **Gating discipline (plan §5).** No CI workflow changes; no alert-
  routing infra; no on-call paging integrations introduced by this PR.

---

## No alerts in this PR

This PR (Track B P3 documentation slice) authors the signal catalogue
and the redaction policy only. No `.yaml` alert rules, no PagerDuty /
Opsgenie / Slack routing configurations, and no SLO budgets are
committed to this repo by this slice. A subsequent gated PR (Track B
P4 instrumentation slice) will emit the signals; alert rule authoring
against those signals happens in `ops/` once P4 ships.

---

## Future alerts expected

Each alert below is tied to a signal in [`../signals.md`](../signals.md).
Threshold values are recommendations from research §4 / plan §4 and are
**revisable** at the first instrumentation slice (P4) once empirical
baselines exist. Severity classes follow the standard
**CRITICAL** (page on-call immediately) / **HIGH** (page during
business hours) / **MEDIUM** (ticket) ladder.

| Alert | Source signal | Severity | Condition (recommended) |
|---|---|---|---|
| **5xx burn-rate alert** | `http_error_5xx_total` / `http_request_count` | HIGH→CRITICAL | Multi-window burn-rate (e.g., 2% of 30-day budget in 1h short window AND 5% in 6h long window). Calibrated at P4. |
| **Cross-tenant rejection — any non-zero** | `cross_tenant_rejection_total` | CRITICAL | `increase(cross_tenant_rejection_total[5m]) > 0`. Any cross-tenant rejection is a security-relevant event (FR-B-008). |
| **RLS context failure — any non-zero** | `db_rls_context_failure_total` | CRITICAL | `increase(db_rls_context_failure_total[5m]) > 0`. The platform's tenant isolation guarantee depends on this being zero (FR-B-009 / Principle II). |
| **Queue lag** | `queue_lag_seconds` (per queue) | HIGH | `queue_lag_seconds{queue=...} > N` for N minutes, where N is set per-queue at P4 based on each queue's SLO. |
| **Queue dead-letter — any non-zero** | `queue_dead_letter_total` (per queue) | HIGH | `increase(queue_dead_letter_total[15m]) > 0`. Dead-letter is operator-triage territory (research §8). |
| **Outbox dead-letter — any non-zero** | `outbox_dead_letter_total` (per event_type, after Track C P7) | HIGH | `increase(outbox_dead_letter_total[15m]) > 0`. Same reasoning as queue dead-letter. |
| **Slow-query threshold breach** | `db_slow_query_total` | MEDIUM→HIGH | Sustained `rate(db_slow_query_total[5m]) > 5/min` over a 5-minute window. Threshold: 500 ms per query (research §4, see `../signals.md` §5). |
| **Auth failure spike** | `auth_failure_total{cause="bad_password"}` | MEDIUM | Anomalous spike (per-tenant or platform-wide). Tuning belongs at P4 once we have baseline noise floor. |
| **Migration failure** | `db_migration_status{state="failed"}` | CRITICAL | `db_migration_status{state="failed"} > 0`. |
| **Idempotency 409 spike** | `idempotency_conflict_total` | MEDIUM | Anomalous spike per-route may indicate a misbehaving client; informational ticket, not a page. |

The alerts above are **expectations**, not commitments. Each ships in
`ops/` under its own change-control discipline.

---

## Alert hygiene rules (apply to all future alerts in `ops/`)

The following rules apply when alert rules are authored in `ops/`. They
exist here because they constrain *signal usage* and therefore belong to
the catalogue-side documentation:

1. **No alert may reference a forbidden metric label.** `tenant_id`,
   `store_id`, `user_id`, `actor_id` are NEVER metric labels (see
   `../signals.md` §6). An alert that would need to discriminate per
   tenant uses logs + trace correlation, not a metric filter.
2. **No alert may embed raw PII or credential material in its annotation
   text.** Alert annotations are surfaced to on-call routing and may
   land in chat channels — the redaction matrix applies. Annotation
   text MUST come from bounded label values (e.g., `route`, `cause`,
   `queue`), never from raw fields.
3. **No alert may run a query that scans the log store** (i.e., no log-
   to-metric ad-hoc inversion). Logs are not a metrics backend.
4. **Every CRITICAL alert MUST have a documented runbook** in `ops/`
   linking back to the affected signal in `../signals.md` and back to
   the redaction matrix where the failure mode involves sensitive
   payloads.

---

## Cross-references

- **Signal catalogue (source of truth for names + thresholds)**:
  [`../signals.md`](../signals.md)
- **Dashboards (also `ops/`-resident)**:
  [`../dashboards/README.md`](../dashboards/README.md)
- **Redaction policy (governs alert annotation contents)**:
  [`../../.specify/memory/redaction-matrix.md`](../../.specify/memory/redaction-matrix.md)

---

## What this README is **not**

- Not an alert rule.
- Not a paging integration.
- Not a vendor selection.
- Not authorization for `ops/` to land in this monorepo.

---

*End of alerts placeholder.*
