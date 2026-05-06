# Failure Classification: [Component / Integration Name]

**Ref**: [spec-id, ADR number, or Architecture Impact Map pointer]
**Author**: [name or role]
**Date**: YYYY-MM-DD
**Constitution**: vX.Y.Z

---

## Scope

One to two paragraphs describing the component or integration this document
covers and why failure classification is required. Reference the Architecture
Impact Map gate that prompted this document, if applicable.

---

## Failure Taxonomy

### Category A — Transient / Retryable

Failures that should be retried automatically with a documented backoff
strategy.

| Failure | Trigger condition | Retry strategy | Max attempts | DLQ on exhaustion? |
|---|---|---|---|---|
| [e.g., JWKS fetch timeout] | [e.g., upstream unavailable] | exponential backoff | N | yes / no |

### Category B — Terminal / Non-Retryable

Failures where retrying cannot produce a different outcome.

| Failure | Trigger condition | Resolution path | DLQ? |
|---|---|---|---|
| [e.g., invalid JWT signature] | [e.g., token tampered] | reject request; return generic error | no |

### Category C — Degraded-Mode Acceptable

Failures where the system should continue operating in a reduced capacity
rather than failing completely.

| Failure | Trigger condition | Degraded behaviour | Recovery path |
|---|---|---|---|
| [e.g., metrics endpoint unreachable] | [e.g., observability sink down] | continue processing; skip metric emission | automatic on recovery |

---

## Circuit Breaker / Fallback Policy

- Circuit breaker: yes / no / N/A
  - If yes: threshold: ___ | window: ___ | open-state behaviour: ___
- Fallback when component is unavailable: [describe what the system does]
- Dead-letter queue: [queue name, or "N/A"]
- DLQ alerting owner: [team or "TBD"]

---

## Retry Policy Summary

| Category | Max attempts | Backoff | Jitter | DLQ |
|---|---|---|---|---|
| Transient | N | exponential / linear | yes / no | yes / no |
| Terminal | 0 | — | — | no |
| Degraded | — | — | — | no |

---

## Alerting Thresholds

Define the metrics and thresholds that trigger a page or notification.

| Metric | Warning threshold | Critical threshold | Owner |
|---|---|---|---|
| Error rate | > X% over Y min | > Z% over Y min | [team] |
| DLQ depth | > X messages | > Y messages | [team] |
| [other] | | | |

---

## Audit and Log Posture (Principles VII, XIII, XIV)

What is captured when a failure occurs, and what is withheld.

- **Logged on failure**: [fields — must include `correlationId` / `request_id`,
  `tenantId` if applicable, error class, and operation name]
- **Redacted fields**: [list — secrets, tokens, invitation secrets, payment
  data, PII payload, raw external responses]
- **Audit event emitted**: yes / no
  - If yes: event type: ___ | logged as: actor `[system]`, operation `[name]`,
    outcome `failure`, target `[resource type]`

---

## Open Questions

Each must be resolved before implementation begins.

1. [Question — note who is responsible for answering]

---

> **When to use this template**
> Fill this when the Architecture Impact Map flags the "External provider
> integration → verification, outage, and failure-mode plan required" gate
> (gate 7), OR when a new async worker introduces a retry / DLQ policy that
> needs to be recorded before implementation (Principle V). Link the filled
> document as the gate pointer in the Architecture Impact Map.
>
> **When NOT to use this template**
> Simple internal CRUD operations with no external dependencies. Low-impact
> refactors contained within one module. Documentation-only or test-only PRs.
> POS API contract changes (those use the Architecture Impact Map's OpenAPI
> gate; this template covers failure modes, not contract parity).
