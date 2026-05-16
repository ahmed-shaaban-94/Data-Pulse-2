# Outbox Event Type Registry

**Ref**: 004-platform-production-readiness (T541)
**Status**: Draft — initial event type registry
**Date**: 2026-05-16

**Cross-references**:
- [lifecycle.md](./lifecycle.md)
- [drainer-design.md](./drainer-design.md)
- [dead-letter-triage.md](./dead-letter-triage.md)
- [spec §8 Track C / FR-C-007](../../specs/004-platform-production-readiness/spec.md)
- [plan §3.3.6](../../specs/004-platform-production-readiness/plan.md)

---

## 1. Registry contract

Every event type that ships in production MUST appear in this registry with:

1. **Name** — dot-separated, namespaced by domain (e.g. `audit.event.created`).
2. **JSON schema** — payload shape, even if illustrative pending the consumer's exact contract.
3. **Producer location** — which existing module emits the event.
4. **Expected consumers** — which worker(s) under `apps/worker/src/outbox/consumers/` will process it.
5. **Retention class** — matches the policy in [lifecycle.md §3](./lifecycle.md): either default (90d delivered / 365d failed) or `audit-relevant` (365d regardless of state).

### 1.1 Adding a new event type
Adding a new event type requires a **separate approval PR** per [plan §5](../../specs/004-platform-production-readiness/plan.md). It is **not** acceptable to introduce a new event type as a side-effect of an `apps/**` PR that happens to also need to publish a new event. The registry change goes first; the producer change comes second.

### 1.2 Single source of truth
- Code MUST NOT publish an `event_type` that does not appear in this registry.
- Reviewers MUST reject PRs that introduce a new `event_type` string in `apps/**` without a corresponding entry here.
- A registry-validation test (future, gated) MAY enforce this at CI time once Track C lands.

---

## 2. Initial entry: `audit.event.created`

This is the **only** event type registered in this feature. It is the lowest-risk first adopter (FR-C-007): the audit pipeline already exists, already has a downstream consumer (`audit-fanout`), and the migration to outbox-mediated emission validates the outbox machinery without introducing a new business flow.

### 2.1 Metadata

| Field | Value |
|---|---|
| **Name** | `audit.event.created` |
| **Producer** | The existing `AuditEmitter` in `apps/api`. Wired through the outbox in T583 (future, gated). |
| **Consumer** | `audit-event-created.consumer` under `apps/worker/src/outbox/consumers/` (T584, future, gated). |
| **Retention class** | **audit-relevant — 365 days** regardless of delivery state. |
| **First slice purpose** | Proof-of-life for the drainer, consumer, dedup projection, and tenant-context establishment. |

### 2.2 Illustrative schema

> The real schema follows the existing 001 audit pipeline contract. The block below is illustrative; the exact field set is locked when T583 is approved.

```json
{
  "audit_event_id": "uuidv7",
  "tenant_id": "uuid",
  "store_id": "uuid | null",
  "actor_id": "uuid | null",
  "operation": "string",
  "target_type": "string",
  "target_id": "string",
  "outcome": "string",
  "metadata": {
    "comment": "redacted per .specify/memory/redaction-matrix.md"
  }
}
```

The payload is JSONB on the wire (within the `outbox_events.payload` column). Per [lifecycle.md §7](./lifecycle.md), the payload is never logged in full; only the envelope fields (`event_id`, `event_type`, `tenant_id`, `correlation_id`, `delivery_state`, `attempts`, `last_error_class`) are loggable.

### 2.3 Rationale (mirrors plan §3.3.6 and FR-C-007)

- The audit pipeline is **already in production** and exercises the multi-tenant primitives end-to-end.
- Its consumer is **already idempotent** at the projection layer, so the move to the outbox dedup projection ([lifecycle.md §5](./lifecycle.md)) is incremental, not foundational.
- A regression in audit delivery is observable: missing audit rows would surface in cross-tenant sweep tests and in the audit-relevant retention queries.
- Choosing audit first means **no new business surface** is exposed to a brand-new mechanism — we change the wire under a known-good consumer.

---

## 3. Out-of-scope event types

These event types are **explicitly not in this feature**. They are listed here so reviewers and future agents do not introduce them as part of the 004 first slice.

| Namespace | Status | Reason |
|---|---|---|
| `catalog.*` | Deferred | Belongs to a catalog implementation feature (003 is spec-only). Per spec §3.3 and §5.1, this feature MUST NOT define catalog-specific outbox events. |
| `pos.*` | Deferred | POS is a separate repository. POS integrates via the OpenAPI contracts in `packages/contracts/openapi/`, not via outbox events emitted from this repo. |
| `payments.*` | Deferred indefinitely | No payments feature exists yet. |
| `inventory.*` | Deferred | No inventory feature exists yet. |
| `billing.*` | Deferred | No billing feature exists yet. |
| `reports.*`, `analytics.*` | Deferred | Out of scope for the production-readiness feature per plan §1 scope guardrail. |

When any of these domains lands a feature that needs outbox events, that feature's spec + plan + tasks introduce the registry entries here as a separate approval PR (§1.1).
