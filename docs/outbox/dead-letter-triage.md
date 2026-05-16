# Outbox Dead-Letter Triage

**Ref**: 004-platform-production-readiness (T549)
**Status**: Draft — operator triage UX design (docs only)
**Date**: 2026-05-16

**Cross-references**:
- [lifecycle.md](./lifecycle.md)
- [drainer-design.md](./drainer-design.md)
- [event-types.md](./event-types.md)
- [research §8 dead-letter triage](../../specs/004-platform-production-readiness/research.md)
- [redaction matrix](../../.specify/memory/redaction-matrix.md)

---

## 1. Triage flow

When the drainer exhausts the 8-attempt retry budget on a row (see [lifecycle.md §4](./lifecycle.md)), the row transitions to `dead_lettered`. From that moment it is invisible to the drainer (it will never be re-claimed automatically) but **fully visible** to operators via the triage flow.

### 1.1 Operator journey

```
   8th failure
        |
        v
  delivery_state = 'dead_lettered'
        |
        v
  outbox_dead_letter_total{event_type} counter increments
        |
        v
  Alert fires (docs/observability/alerts/* — placeholder)
        |
        v
  Operator opens triage UI (or first-slice: calls the admin endpoint)
        |
        v
  Operator inspects redacted context  ----+
        |                                 |
        +-- replay  --> state = 'pending' (attempts reset to 0; audit event emitted)
        |
        +-- acknowledge --> state = 'acknowledged' (no action; audit event emitted)
```

### 1.2 What the operator sees
The triage view returns a strict, redacted projection of the row — never the raw payload (§4). The operator decides between two terminal actions: **replay** or **acknowledge**. Both emit an audit event.

---

## 2. Triage mechanism — locked per research §8

### 2.1 Choice

**Admin endpoint behind `RolesGuard`, restricted to an operator-only role.**

- HTTP-only — operators interact with dead-lettered events through the SaaS API surface, exactly like every other privileged action.
- The API enforces RLS-context, redaction, and audit emission uniformly.

### 2.2 Rejected / deferred alternatives

| Alternative | Status | Reason |
|---|---|---|
| **CLI tooling** (operator script that connects via a service account) | **Deferred** to a later slice if operator feedback demands it after the HTTP endpoint ships. | An HTTP endpoint already covers the use case. CLI doubles the audit surface area and the auth surface. |
| **Direct Postgres access** (psql, JDBC, etc.) | **Rejected.** | Constitution §II requires every access path to go through tenant-aware, RLS-respecting code. A human running `UPDATE outbox_events SET ...` is a forbidden bypass. The runtime DB role does **not** bypass RLS, and operators are not granted a separate bypass role. |
| **Auto-replay heuristics** (retry dead-lettered rows on a schedule) | **Rejected.** | Dead-letter is the explicit "human investigation required" state. Auto-replay defeats the purpose and risks compounding the original failure. The 8-attempt retry budget is the auto-replay envelope. |

---

## 3. Admin endpoint shape

> **Illustrative — NOT to be implemented in this slice.** The endpoint design is gated per [plan §5](../../specs/004-platform-production-readiness/plan.md). It is documented here so the lifecycle, the redaction obligation, and the audit contract are all in one place.

### 3.1 List dead-letters

```
GET /api/v1/admin/outbox/dead-letters
  ?event_type=audit.event.created
  &tenant_id=<uuid>
  &cursor=<opaque>
  &limit=50
```

Response (illustrative):
```json
{
  "data": [
    {
      "event_id": "uuidv7",
      "event_type": "audit.event.created",
      "tenant_id": "uuid",
      "store_id": "uuid | null",
      "correlation_id": "uuid",
      "attempts": 8,
      "last_error_class": "ConsumerTimeout",
      "created_at": "2026-05-16T10:00:00Z",
      "processed_at": "2026-05-16T11:30:00Z",
      "delivery_state": "dead_lettered"
    }
  ],
  "meta": { "next_cursor": "opaque", "limit": 50 }
}
```

The response **never** includes the raw `payload`.

### 3.2 Replay

```
POST /api/v1/admin/outbox/dead-letters/{event_id}/replay
```

- Transitions the row from `dead_lettered` back to `pending`.
- Resets `attempts` to 0 and clears `next_attempt_at`.
- Emits a `manual.outbox.replay` audit event (registry entry: deferred — added by the slice that implements this endpoint).
- Returns the updated envelope (same shape as the list response).

### 3.3 Acknowledge

```
POST /api/v1/admin/outbox/dead-letters/{event_id}/acknowledge
```

- Transitions the row from `dead_lettered` to `acknowledged` (a new terminal state).
- Used when the operator has investigated and decided no action is needed (e.g. the underlying business state was corrected out-of-band, or the event is no longer relevant).
- Emits a `manual.outbox.acknowledge` audit event.
- Returns the updated envelope.

> Note: the `acknowledged` state is in addition to the enum documented in [lifecycle.md §2](./lifecycle.md). When this triage slice is implemented, the enum is extended; the schema change is gated.

---

## 4. Redaction

The triage endpoints follow the same redaction discipline as the rest of the system, deferring to [`.specify/memory/redaction-matrix.md`](../../.specify/memory/redaction-matrix.md).

### 4.1 Returned fields (strict allowlist)

| Field | Why safe |
|---|---|
| `event_id` | Opaque UUIDv7. |
| `event_type` | Registry-controlled string. Low cardinality. |
| `tenant_id` | Operator role is platform-level (§5); seeing tenant ids is part of the role. |
| `store_id` | Same as `tenant_id`. |
| `correlation_id` | Opaque UUID; useful for cross-system tracing. |
| `attempts` | Integer counter. |
| `last_error_class` | Registry of error class names, not the raw message. |
| `created_at`, `processed_at` | Timestamps. |
| `delivery_state` | Enum. |

### 4.2 Never returned
- The raw `payload` JSON.
- The full `last_error` string (only the error class is exposed).
- Any PII that happens to be encoded inside the payload.

If an operator genuinely needs to see payload contents to investigate a class of failures, that is a **separate gated capability** with its own audit surface, additional role, and short-lived access tokens — out of scope for this design.

---

## 5. Authorization model

### 5.1 Operator role

| Property | Value |
|---|---|
| Proposed role name | `platform:operator` (TBD; pinned at implementation time) |
| Scope | **Platform-level**, not tenant-scoped. The operator is acting on the SaaS-wide surface, not on behalf of any tenant. |
| Grant mechanism | Explicit per operator account, recorded in the role assignment audit log. Never inherited from tenant membership. |
| Revocation | Immediate, via the same admin surface that grants the role. |

### 5.2 Endpoint enforcement
- `RolesGuard` rejects any request that does not present `platform:operator`.
- The endpoint MUST **not** be reachable from any tenant-scoped API surface.
- The endpoint MUST verify that the actor's identity is a real operator account, not an automated agent (Constitution §XII — IDs in bodies are not trusted; the actor comes from the authenticated principal, not from a request field).

### 5.3 Audit trail
- Every triage action (`replay`, `acknowledge`) emits an audit event capturing actor, target `event_id`, `tenant_id`, `correlation_id`, timestamp, and outcome (Constitution §XIII).
- Read-only list calls (§3.1) emit a lower-severity audit event (TBD) so a pattern of operator inspection is itself observable.

### 5.4 Cross-tenant safety
- The operator role is intentionally **outside** the tenant context. The triage endpoint enforces that the operator is acting on the platform surface — it does **not** establish tenant context from the request, and it does **not** require the operator to "impersonate" a tenant.
- When the operator replays a row, the **consumer** still establishes tenant context from the event's `tenant_id` (see [lifecycle.md §6](./lifecycle.md)). The operator never bypasses tenant-context establishment downstream.
