# ADR 0009 — Per-Device Rate Limiting for POS Write Endpoints

**Status**: Proposed
**Date**: 2026-06-19
**Owner**: Owner (Ahmed Shaaban)
**Constitution version**: (current)
**Feature / Ref**: Audit finding **M-2** (super-deep audit, 2026-06-19) · `apps/api/src/auth/rate-limit.ts` · Orchestrator audit-fix report `docs/status/audit-fix-pass-2026-06-19.md`

---

## Context

The 2026-06-19 super-deep audit (finding **M-2**) observed that rate limiting today
covers **only authentication endpoints**. Verified against `origin/main` (`203ef10`+,
`apps/api/src/auth/rate-limit.ts`), `RATE_LIMIT_BUCKETS` defines exactly four buckets,
all auth-scoped:

- `signInPerAccount` — 5 / 15 min
- `signInPerIp` — 30 / hour
- `passwordResetPerIp` — 100 / day
- `passwordResetConfirmPerIp` — 10 / 15 min  *(added by #593, F-01..F-13 hardening)*

No **write** endpoint is rate-limited. In particular `POST /api/pos/v1/sales`
(sale capture), `POST /api/v1/settlement/settlement-intent`, and
`POST /api/pos/v1/vouchers/redeem` have **no per-caller throughput ceiling**. The
`IdempotencyInterceptor` prevents *duplicate* processing of the same key, but it does
**not** limit *distinct* requests — a compromised or malfunctioning POS terminal
holding a valid operator envelope could flood a write endpoint with unique payloads.

The mechanism to fix this **already exists and need not be built**: `RateLimiter.check(bucketName, identifier, bucket)`
(same file) is a generic Redis fixed-window counter; the four auth buckets are just
config over it. Extending coverage to write endpoints is therefore a **policy +
wiring** decision, not a new subsystem. The decisions below fix the *policy* (which
dimension, what posture) so a later implementation slice can wire it without
re-litigating the architecture.

This touches the auth/trust layer (the ADR template's "Critical" trigger), so it is
recorded as an ADR rather than buried in a spec section.

---

## Decisions

### D1. Rate-limit POS/settlement write endpoints, keyed per **device**, not per IP or per operator token

Add write-endpoint rate limiting using the existing `RateLimiter` primitive, with the
**paired-device identity** as the bucket identifier dimension.

| Alternative considered | Ruled out because |
|---|---|
| **Per IP** | POS terminals in one store sit behind a single NAT/router and share an egress IP — a per-IP limit either throttles a whole healthy store at once or must be set so high it stops protecting anything. |
| **Per operator token (envelope)** | The operator envelope has a fixed **8-hour TTL** and is re-acquired on every re-sign-in (FR-POS-AUTH-5). An abuser simply re-authenticates to reset the budget; a long shift legitimately rotates the key. The budget would not track a stable subject. |
| **Per tenant** | Too coarse — one abusive terminal would consume the whole tenant's budget and degrade every other terminal in the tenant. |
| **Per device (chosen)** | The paired terminal is the **stable, abuse-resistant** subject DP-2 already resolves in the operator/device auth path. It survives token rotation, isolates a bad terminal from its peers, and matches the real unit of POS throughput (one terminal = one sale stream). |

- **Tradeoff**: a device legitimately running an unusually high sale rate (e.g. a busy
  single-lane terminal during a rush) could brush the ceiling. Mitigated by D2 (tunable
  starting defaults, set well above realistic single-terminal throughput) and by
  surfacing `resetMs` so the client can back off gracefully.

### D2. Thresholds are **tunable starting defaults**, not frozen contract

Ship conservative initial buckets, explicitly marked tunable from production telemetry —
not fixed numbers baked into the trust layer. Proposed starting points (to be confirmed
at implementation against observed pilot rates):

| Endpoint | Proposed starting bucket |
|---|---|
| `POST /api/pos/v1/sales` | ~300 / hour / device |
| `POST /api/v1/settlement/settlement-intent` | ~120 / hour / device |
| `POST /api/pos/v1/vouchers/redeem` | ~120 / hour / device |

- **Tradeoff**: starting values are estimates; they will be revised once the
  observability layer (AD-TOOL-003) reports real per-device write rates. The decision
  fixes the *shape* (per-device hourly buckets), not the final integers.

### D3. Redis-unavailable posture: **fail-open for writes**, with an alert — decided together with M-5

`RateLimiter.check()` calls `redis.incr()`, which **throws** if Redis is unavailable.
The wiring must therefore decide explicitly whether a Redis outage **fails open** (allow
the write — favour availability/selling) or **fails closed** (reject — favour the limit).

**Decision: fail-open for POS write endpoints during a Redis outage, paired with a
metric/alert** so operations sees the degraded state. Rationale: the rate limit is a
defence-in-depth throttle, not the primary correctness control (idempotency + operator
re-verification remain in force); blocking sales because the *rate-limiter's* datastore
is down would convert a security throttle into a selling outage — the wrong failure mode
for a POS. The same Redis-outage axis governs audit finding **M-5** (idempotency
`store.save` best-effort); these two MUST be decided coherently — M-5's lower-regret path
is likewise observe-and-degrade (metric/alert), not hard-fail. See Open Questions Q1.

- **Tradeoff**: during a Redis outage the per-device throttle is temporarily absent. The
  exposure window is bounded by the outage duration and is surfaced by the alert; the
  other write-path defences (idempotency dedup, live operator re-verification) are
  unaffected.

---

## Hard out-of-scope

This ADR decides **policy**; it does not author the implementation.

- It does **not** edit `apps/api/src/auth/rate-limit.ts`, add buckets to
  `RATE_LIMIT_BUCKETS`, or wire any guard/interceptor onto a route. That is a separate,
  gated implementation slice.
- It does **not** finalize the threshold integers (D2 gives starting defaults only).
- It does **not** decide the Redis production-client wiring (already a separate slice, per
  the `RateLimiter` docstring).
- It does **not** touch any OpenAPI/contract surface, migration, or auth logic beyond the
  rate-limit dimension.
- It does **not** change the four existing auth buckets.

---

## Constitution Alignment

| Principle | Relationship |
|---|---|
| Authorization & Object Safety (trust layer) | strengthened — adds a per-device abuse ceiling on write surfaces |
| Multi-Tenant SaaS by Default | strengthened — per-device keying prevents one terminal degrading a tenant/store's peers |
| Availability of selling (POS-first) | in tension at D3 — resolved by fail-open-with-alert so a rate-limiter datastore outage does not block sales |

The D3 availability-vs-security tension is resolved in favour of fail-open **for this
specific throttle only**, because correctness controls (idempotency, operator
re-verification) are independent of it.

---

## Open Questions

1. **Coherence with M-5 (idempotency save failure).** D3 chooses fail-open + alert for
   the rate limiter on Redis outage. M-5 must adopt the same observe-and-degrade posture
   (not 503-hard-fail) so the two Redis-outage behaviours are coherent. Resolve M-5 in the
   same implementation cycle or a sibling ADR before either ships.
2. **Threshold calibration** depends on the AD-TOOL-003 observability layer reporting real
   per-device write rates; the D2 defaults are placeholders until then.
3. **Identifier resolution at the write boundary** — confirm the device identity is
   available on the request principal at the point the guard runs for each of the three
   endpoints (it is resolved in the operator/device auth path; the wiring slice must verify
   it is on `request.principal` before the rate-limit guard executes).

---

## References

- Audit finding **M-2** — `audit-report.md` (independent audit, 2026-06-19)
- Orchestrator audit-fix report — `docs/status/audit-fix-pass-2026-06-19.md` (Retail-Tower-Orchestrator)
- `apps/api/src/auth/rate-limit.ts` — the existing `RateLimiter` primitive + four auth buckets (verified on `origin/main` `203ef10`+)
- Related audit finding **M-5** (idempotency `store.save` best-effort) — same Redis-outage axis (Open Question Q1)
- #593 (F-01..F-13 security hardening) — added the `passwordResetConfirmPerIp` bucket
