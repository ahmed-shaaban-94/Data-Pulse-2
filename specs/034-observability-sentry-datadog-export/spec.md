# Spec 034 — Observability: Sentry Errors + Datadog OTLP/Logs Export

**Status:** SPECIFY-ONLY — draft for owner review. No SDK install, no DSN/API key, no service code, no OpenAPI, no migration, no new endpoint authored or implied here.
**Repo:** Data-Pulse-2.
**Date:** 2026-06-17.
**Parent:** Orchestrator [AD-TOOL-003 — Observability Layer: Sentry + Datadog](https://github.com/ahmed-shaaban-94/Retail-Tower-Orchestrator/blob/main/docs/decisions/AD-TOOL-003-observability-layer-sentry-datadog.md) (Accepted, owner-ratified 2026-06-17) + its [Phase 0 inventory](https://github.com/ahmed-shaaban-94/Retail-Tower-Orchestrator/blob/main/docs/tooling/observability-phase-0-inventory.md).
**Builds on (existing DP-2 work — NOT re-decided here):**
- The OTel observability layer from **Spec 004 (Track B / P4, T444–T472)**: `apps/api/src/instrumentation.ts` + `apps/worker/src/instrumentation.ts` (`startOtel({…})` at module-eval), `apps/{api,worker}/src/observability/metrics/*` (`getMeter`-registered signals), `packages/shared` (`startOtel`, `getMeter`, label-policy enforcement).
- The signal catalogue [`docs/observability/signals.md`](../../docs/observability/signals.md) and the redaction single-source-of-truth [`.specify/memory/redaction-matrix.md`](../../.specify/memory/redaction-matrix.md).

**Excludes (hard boundary):** any new HTTP endpoint (no new `/health`, `/metrics`, `/readyz` — DP-2 already exposes a Prometheus drain and the OTel layer; synthetics target existing routes); any OpenAPI/contract-surface change; any migration; any `package.json`/lockfile edit; any committed DSN/key; any change to the existing signal names or redaction matrix. This spec describes **what to wire to existing seams**, under DP-2 review, when separately owner-approved.

---

## 1. Summary

Data-Pulse-2 already emits a rich, **vendor-neutral OpenTelemetry** signal set (Spec 004 / Track B): API + worker + DB metrics via `getMeter`, an `instrumentation.ts` `startOtel()` bootstrap seam, a Prometheus exporter drain, and a redaction matrix governing every log boundary. What it lacks is (a) **error/exception capture** routed to a human triage surface, and (b) a **drain to the program's chosen vendors** (Datadog for platform signals).

This spec defines, per AD-TOOL-003's boundary, how DP-2 adopts the two ratified tools **on top of the existing OTel layer**, adding no parallel observability system:

- **Sentry** (AD-TOOL-003 D1) — backend **unhandled exceptions only**. The genuinely-missing layer.
- **Datadog** (AD-TOOL-003 D2) — the platform drain: register a **Datadog OTLP exporter as one more `MetricReader`/span-exporter** in the existing `startOtel()` seam ("the Prometheus exporter is one drain among several" — `signals.md`), plus **log shipping** of the already-redacted structured logs, plus **synthetics against existing routes**.

DP-2 is the contract/orchestration boundary; this spec keeps observability strictly orthogonal to the business-data path (AD-TOOL-003 D5).

## Clarifications

> Append-only. Scope-resolving only; mechanism detail routes forward to a future `plan.md`. Does not re-decide any §10 owner item.

### Session 2026-06-17

- Q: Does this spec add a new metrics/health endpoint for Datadog synthetics to hit? → A: **No.** DP-2 already exposes a Prometheus scrape drain and the OTel layer; synthetics target **existing** public routes (the edge, `/pair`, read-down) per AD-TOOL-003. A new endpoint would be contract surface and is explicitly excluded (§Excludes). Confirming the exact synthetic target list is deferred to `plan.md`.
- Q: Does Datadog metrics export re-instrument the code or change signal names? → A: **No.** It registers a Datadog OTLP `MetricReader`/exporter against the **existing** `getMeter` instruments via the `startOtel()` seam. Signal names in `signals.md` are unchanged. (FR-B-007 vendor-neutrality preserved — Datadog is added as a drain, not a replacement.)
- Q: Where does log redaction for Datadog Logs come from? → A: The **existing** `.specify/memory/redaction-matrix.md` is the single source of truth; Datadog Logs ships the already-redacted structured logs. No new redaction policy is authored here. (OQ-4 log-PII is already solved in DP-2.)

---

## 2. Goals

- **G1** — Capture DP-2 (api + worker) **unhandled exceptions** in Sentry, with the POS-Pulse `beforeSend` scrub-or-drop pattern reused (port `isForbiddenSentryKey` semantics; align to the redaction matrix).
- **G2** — Drain the **existing OTel metrics + traces** to Datadog by registering a Datadog OTLP exporter in the existing `startOtel()` seam — no re-instrumentation, no signal-name change.
- **G3** — Ship the **already-redacted structured logs** to Datadog Logs.
- **G4** — Datadog **synthetics/uptime** against existing public routes (edge, `/pair`, a read-down route) — no new endpoint.
- **G5** — All vendor enablement is **DSN/key-gated and default-inert** (the POS-Pulse posture): empty/missing key → exporter/SDK is a no-op; the service boots normally.

## 3. Non-goals

- No new HTTP endpoint of any kind (no `/health`, `/metrics`, `/readyz`).
- No OpenAPI / contract-surface change; no migration; no `package.json`/lockfile edit in this spec.
- No change to existing signal names, the `getMeter` registry, or the redaction matrix.
- No APM trace correlation to Sentry (that is AD-TOOL-003 Phase 3, a future spec).
- No Connector or ERPNext instrumentation (Connector is its own spec; ERPNext core is never instrumented — AD-TOOL-003 D4).
- No SLO/alert-rule authoring as code (alert routing = Email + Telegram per Phase 0 OQ-5, configured in-tool, not here).

## 4. Architecture fit (existing seams this rides on)

| Concern | Existing DP-2 seam | What Phase 1/2 adds |
|---|---|---|
| Metrics | `getMeter` instruments (`observability/metrics/*`), no-op until a `MetricReader` is registered | Register a **Datadog OTLP MetricReader** in `startOtel()` (alongside the Prometheus drain) |
| Traces | OTel SDK in `instrumentation.ts`; bullmq span propagation in `packages/shared` | Add a **Datadog OTLP span exporter** drain (sampling per §6) |
| Logs | Structured logs redacted via `redaction-matrix.md` | **Ship to Datadog Logs** (already-redacted) |
| Errors | *(none today — gap)* | **`@sentry/node`** init, DSN-gated, `beforeSend` scrub (port POS-Pulse) |
| Uptime | Existing public routes (edge, `/pair`, read-down) | **Datadog Synthetics** hit existing routes |

## 5. Privacy / redaction (OQ-4)

- **Logs:** governed by the existing `.specify/memory/redaction-matrix.md` — unchanged, reused as-is.
- **Errors (Sentry):** port the POS-Pulse posture (Phase 0 §2.1) — `sendDefaultPii: false`, `integrations: []` (review each before enabling), `beforeSend` scrub-or-drop over the DP-2 forbidden-key set aligned to the redaction matrix; never ship Clerk tokens/JWTs, operator identity, patient/RX, or full card data; never ship business/catalog/inventory/sales payloads (AD-TOOL-003 D5).
- **Metrics/traces:** the existing label-policy enforcement already rejects high-cardinality / forbidden labels (e.g. `tenant_id`) at compile-time + load-time — Datadog inherits this unchanged.

## 6. Sampling (OQ-3 — conservative-by-default; the compensating control for the no-cap decision, Phase 0 OQ-1)

- **Errors:** 100% (never sample failures).
- **APM traces:** start low (~10% head-based), 100% on error spans and the **sale-capture / sync path** (the highest-value cross-hop flow).
- **Logs:** WARN+ shipped to Datadog; INFO sampled.
- Rates are config-driven (env), tunable after the first pilot week's observed ingestion volume.

## 7. Secrets (R-4)

`SENTRY_DSN`, Datadog API/OTLP keys live in **droplet env vars sourced from 1Password** (matches DP-2's existing prod-secret externalization). Never committed. `.env.example` carries empty keys (default-inert).

## 8. Acceptance criteria

- AC-1: With all keys empty, api + worker boot identically to today (exporters/SDK inert; existing Prometheus drain unaffected).
- AC-2: With a Sentry DSN set, an induced unhandled exception appears in Sentry **scrubbed** (no forbidden keys, no business payload), and the service does not crash if Sentry init fails.
- AC-3: With Datadog keys set, the **existing** named signals from `signals.md` appear in Datadog with no signal-name drift and no new endpoint added.
- AC-4: Datadog Logs show only redaction-matrix-compliant fields.
- AC-5: Synthetics monitors target only pre-existing routes.

## 9. Scope of authority / lifecycle

`SPECIFY-ONLY`. No `/plan` or `/tasks` run. The SDK dependency add, the `startOtel()` exporter wiring, the Sentry init module, and the synthetics config are authored by a **separate DP-2 implementation slice under DP-2 review**, only when AD-TOOL-003 Phase 1/Phase 2 is separately owner-approved. Local authoring here is preparation evidence, not `origin/main` truth.

## 10. Owner decisions (deferred — NOT decided here)

| OD | Question | Status |
|---|---|---|
| OD-1 | Datadog ingest path: OTLP exporter direct vs Datadog Agent on the droplet as OTLP collector? | OPEN — `plan.md`. |
| OD-2 | Exact synthetics target route list (edge + `/pair` + which read-down route). | OPEN — `plan.md`. |
| OD-3 | Whether worker (BullMQ) traces export in Phase 2 or defer to a later slice. | OPEN. |

> **SPECIFY-ONLY spec.** Records the DP-2-side observability wiring design on top of the existing OTel layer. Authors no SDK, key, code, contract, migration, or endpoint. Each downstream activity remains independently owner-gated per AD-TOOL-003 D6.
