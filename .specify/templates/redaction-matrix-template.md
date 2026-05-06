# Redaction Matrix: [Feature / Entity Name]

**Ref**: [spec-id or task ID]
**Author**: [name or role]
**Date**: YYYY-MM-DD
**Constitution**: vX.Y.Z

---

## Scope

One to two sentences: what entity or feature this document covers and why
a redaction matrix is needed here. Reference the Constitution principle(s)
that require it (Principles VII and XIV).

---

## Data Classification

Classify every persisted field introduced by this feature. Classification
drives logging redaction, retention, export, and erasure behaviour.

| Field / property | Classification | Rationale |
|---|---|---|
| `email` | PII | direct identifier |
| `password_hash` | PII · credential | must never appear in logs, responses, or audit metadata |
| `invitation_token` | credential | one-time secret; never logged |
| `phone_number` | PII | direct identifier |
| `tenant_id` | business | safe to log — not a secret |
| `store_id` | business | safe to log — not a secret |
| `correlation_id` | business | safe to log |
| `amount` | payment | log only as a masked amount class where needed |
| `[field]` | public | freely logged and returned |

Classification values: **PII** · **payment** · **business** · **public** · **credential**

*(Remove rows that don't apply. Add one row per new field introduced by
this feature.)*

---

## Log Boundary Rules (Principle VII)

For each log-emitting site introduced or modified by this feature, state
what is emitted and what is redacted. Redaction MUST be enforced at the
logger boundary — not at call sites.

| Log / emit site | Fields emitted | Fields redacted | Redaction method |
|---|---|---|---|
| Auth failure handler | `actor_label`, `request_id`, error class | password, token, invitation secret | [serializer / sanitiser utility path] |
| Worker failure handler | `correlationId`, `tenantId`, job name, error class | PII payload, secrets | [utility path] |
| Audit event emitter | actor, operation, target type+id, outcome, `correlationId` | PII beyond actor identity, secrets, tokens | [utility path] |
| [other log site] | ... | ... | ... |

*(Add one row per log-emitting site. Delete rows for sites this feature
does not touch.)*

---

## Retention Windows (Principle XIV)

| Classification | Retention window | Sweep mechanism |
|---|---|---|
| PII (non-audit) | [e.g., 30 days after account closure — or "TBD: see spec §XIV"] | [scheduled job name, or "TBD"] |
| Payment data | [e.g., 7 years — regulatory — or "TBD"] | TBD |
| Audit records | Indefinite; PII fields tombstoned on erasure | Privileged platform operation (not application-layer) |
| Business / operational | [tenant-configured — or "TBD"] | TBD |
| Public | No retention constraint | — |

*(If retention windows for this feature are not yet decided, write "TBD:
deferred to [spec-id or future slice]" rather than leaving blank. TBD is
acceptable; silence is not.)*

---

## Right-to-Erasure Posture (Principle XIV)

- Erasure flow documented: yes / no / deferred to [spec-id]
- If yes: erasure flow path: [link to spec section or flow description]
- Audit immutability preserved by: tombstoning PII fields in audit rows
  / [alternative approach — justify]
- Cross-border / data-residency posture: [single region — or "TBD — state
  an answer before multi-region is considered"]

---

## Open Questions

Each must be resolved before the feature ships PII-bearing fields to
production.

1. [Question — who answers it]

---

> **When to use this template**
> Fill this when a new entity introduces PII, payment data, credentials,
> or sensitive business fields that must be classified under Principle XIV.
> Also fill this when adding a new log-emitting code path (audit event
> emitter, error handler, worker failure log) that may encounter classified
> data. Reference the filled matrix from the spec's data model section or
> from the Architecture Impact Map's auth / redaction gate pointer.
>
> **When NOT to use this template**
> Infrastructure-only changes with no new field additions. Refactors that
> move or rename code but introduce no new fields and no new log sites.
> Test-only or documentation-only PRs. PRs where every new field is
> classified `business` or `public` with no change to any log site.
