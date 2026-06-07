# Data Model — 020 Connector Health and Connection-Status API

Phase 1 output. One new table `connector_health`, referencing the 018 `connector_registration` by FK. Reuse of nothing else mutable. **No money, no PII, no secret** anywhere (§XIV; BUSINESS-class observational data). The migration (expected `0022_connector_health`, number confirmed at gate time) and the Drizzle schema are `[GATED]` `packages/db` — **described here in prose only; NOT authored in this planning pass.**

## Entity 1 — `connector_health` (new table)

The current liveness read-model for one connector instance. Exactly one row per `connector_registration` (created lazily on first heartbeat, or eagerly — see "Row lifecycle"). Holds no secret. Last-write-wins.

| Column | Type | Constraints | Notes |
|---|---|---|---|
| `id` | uuid | PK (UUIDv7) | surrogate PK |
| `tenant_id` | uuid | NOT NULL, FK → `tenants(id)` ON DELETE RESTRICT | RLS axis; mirrors `0019`/`0020`/`0021` |
| `connector_registration_id` | uuid | NOT NULL, FK → `connector_registration(id)` **ON DELETE CASCADE**, **UNIQUE** | one health row per registration; cascades on registration delete (see lifecycle note) |
| `last_seen_at` | timestamptz | NULL | **server clock** at last accepted heartbeat; NULL ⇒ `never_seen`. The only field the liveness verdict reads. |
| `connector_version` | text | NULL, CHECK `length(connector_version) <= 64` | self-reported connector software version |
| `backlog_indicator` | integer | NULL, CHECK `backlog_indicator >= 0` | self-reported lag/backlog (e.g. pending postings); non-negative |
| `erpnext_reachable` | boolean | NULL | self-reported ERPNext-reachability flag (NOT a DP2 probe result) |
| `source_clock_at` | timestamptz | NULL | connector-reported clock; **provenance only**, never used for the verdict (§X) |
| `reported_fields_at` | timestamptz | NULL | server clock when the self-reported fields above were last updated |
| `created_at` | timestamptz | NOT NULL DEFAULT now() | |
| `updated_at` | timestamptz | NOT NULL DEFAULT now() | bumped on each heartbeat upsert |

**Constraints & posture:**
- **UNIQUE `(connector_registration_id)`** — enforces one-health-row-per-registration; the upsert conflict target for the LWW heartbeat write.
- **RLS fail-closed** — empty-GUC CASE guard; SELECT/INSERT/UPDATE scoped to `current_setting('app.current_tenant', true)::uuid`; mirrors `0019`/`0020`/`0021`. Runtime role never `BYPASSRLS`. No DELETE policy from the application layer (health rows disappear only via the registration FK cascade).
- **No `version` column** — last-write-wins (justified, plan.md Complexity Tracking). Concurrent heartbeats converge to the latest `now()`.
- **§XIV**: BUSINESS-class. No PII, no money, no secret. `connector_version`/`backlog_indicator`/`erpnext_reachable` are non-PII operational telemetry.
- **§IX**: this is a **read-model / observational projection**, not a source of truth. The identity source of truth is 018 `connector_registration`; ERPNext-reachability is preserved as connector self-report (provenance), not as a DP2-derived fact.

**Tenant-consistency note**: `tenant_id` is stored denormalized for the RLS axis but MUST equal the linked registration's `tenant_id`. The heartbeat write derives `tenant_id` from the 018 guard-attached context (which already matches the registration per the 018 usability predicate clause 6), never from the body. A future `[GATED]` CHECK or trigger asserting `connector_health.tenant_id = connector_registration.tenant_id` MAY be added; for v1 the guard-derived write + RLS make a cross-tenant mismatch unreachable from the application path.

## Entity 2 — `connector_registration` (from 018 — referenced, NOT modified)

020 reads `connector_registration(id, tenant_id, display_name, environment, erpnext_site_ref, disabled_at)` to (a) join identity into the operator status projection and (b) feed the `disabled` branch of the verdict. **020 does not add columns to, or mutate, `connector_registration`.** The 018 `0021` migration stays closed.

## Derived value — Liveness Verdict (computed at read, NOT stored)

Pure function `deriveLiveness(last_seen_at, now, threshold, registration.disabled_at) → 'healthy' | 'stale' | 'never_seen' | 'disabled'`:

1. if `registration.disabled_at IS NOT NULL` → `disabled` (precedence over all liveness states);
2. else if `last_seen_at IS NULL` → `never_seen`;
3. else if `now - last_seen_at <= threshold` (default 5 min) → `healthy`;
4. else → `stale`.

Never persisted — it is a function of the current server clock. Recomputed on every read. This is why no scheduled sweep is needed in v1 (§V deferral).

## Row lifecycle

- **Create**: lazily on the first accepted heartbeat for a registration (upsert INSERT branch). Alternatively eager creation at 018 registration time is possible but NOT required and is out of 020 scope (would touch the 018 path). v1 = lazy.
- **Update**: each accepted heartbeat upserts `last_seen_at = now()`, the self-reported fields, `reported_fields_at = now()`, `updated_at = now()` (LWW).
- **Delete**: only via `ON DELETE CASCADE` when the parent `connector_registration` is deleted. The application layer never deletes health rows directly. (018 registrations are logically disabled, not deleted, in normal operation — so cascade delete is an edge path; `disabled_at` is the normal terminal state, and the health row is retained and readable per FR-016.)

## Wire projections (§IV — no raw DB entities)

- **`ConnectorHealthView`** (list + detail item): `{ connectorId (=registration id), displayName, environment, erpnextSiteRef, lastSeenAt (nullable), liveness ('healthy'|'stale'|'never_seen'|'disabled'), secondsSinceLastSeen (nullable), connectorVersion (nullable), backlogIndicator (nullable), erpnextReachable (nullable), reportedFieldsAt (nullable) }`. **No** `id` of the health row, **no** `tenant_id`, **no** secret/token. Detail and list items share this shape (detail = single object; list = array, possibly empty).
- **`HeartbeatAck`** (heartbeat response): minimal `{ acknowledgedAt }` (server clock). No identity echo beyond what the connector already knows; no secret.

## RLS / isolation test posture (§VI)

- RLS bypass probe: wrong `app.current_tenant` → 0 rows from `connector_health`.
- Cross-tenant sweep: tenant A admin cannot list/read tenant B's connector health (safe 404 / absent from list).
- Malicious-override: heartbeat body carrying `tenant_id`/`registration_id`/`last_seen_at` → ignored; identity from guard context only.
- Migration round-trip `0022` UP→DOWN→UP; append `0022` to `cli/migrate.spec` `EXPECTED_MIGRATIONS`; add the new schema module to the barrel allowlist; re-call `ensureAppRole` after the migration (grants only cover tables-at-grant-time).
- Convergence: two concurrent heartbeats → one row, latest `last_seen_at`.
- Threshold boundary: `last_seen_at` exactly at / just past the 5-min threshold resolves deterministically.
