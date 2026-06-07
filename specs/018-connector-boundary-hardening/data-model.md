# Data Model — 018 Connector Boundary Hardening v1

Phase 1 output. Migration **`0021_connector_registration`** (next free after `0020`). One new table + one nullable FK column on `auth_tokens` + reuse of `audit_events`. **No money, no PII, no raw-secret column anywhere** (§XIV; BUSINESS-class). `[GATED]` `packages/db` — gate pre-approved 2026-06-06; preflight discipline (R3) still applies.

## Entity 1 — `connector_registration` (new table)

Stable, operator-facing identity of one connector deployment for one tenant. Survives credential rotation. Holds no secret.

| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | PK (UUIDv7) — the `connector_id` operators / audits / 020 / 019 / 023 reference |
| `tenant_id` | uuid | NOT NULL, FK → `tenants(id)` ON DELETE RESTRICT |
| `display_name` | text | NOT NULL, **CHECK `length(btrim(display_name)) > 0`** (non-empty/trimmed) |
| `erpnext_site_ref` | text | NOT NULL — ERPNext site label/ref (NOT a secret) |
| `environment` | text | NOT NULL, **CHECK in (`dev`,`staging`,`pilot`,`prod`)** — these are the canonical **wire values** the request DTO accepts and the CHECK enforces (the spec's prose "development / staging / pilot / production" maps to these tokens; DTO and CHECK MUST agree on the tokens). |
| `created_at` | timestamptz | NOT NULL DEFAULT now() |
| `created_by` | uuid | NOT NULL, FK → `users(id)` ON DELETE RESTRICT (the acting admin) |
| `disabled_at` | timestamptz | NULL — logical disable |
| `disabled_by` | uuid | NULL, FK → `users(id)` ON DELETE RESTRICT |

**Constraints:**
- **Unique `(tenant_id, environment, erpnext_site_ref)`** — clarification Q1: a tenant cannot register the same ERPNext site twice in the same environment (FR-005a).
- **RLS fail-closed** — empty-GUC CASE guard, SELECT/INSERT/UPDATE scoped to `app.current_tenant`; mirror `0019`/`0020`. Runtime role never BYPASSRLS. No DELETE policy (disable is logical; rows are retained for audit — FR-014).
- **§XIV:** BUSINESS-class. No PII, no money, no secret.

## Entity 2 — `auth_tokens` (existing table — additive change)

| Change | Detail |
|---|---|
| **Add** `connector_registration_id uuid NULL` | FK → `connector_registration(id)` **ON DELETE RESTRICT**. NULL for non-connector scopes; required for connector tokens (see consistency CHECK). This is the **only** shared-table change — a *link*, not connector metadata. |
| **CHECK (preflight-gated)** scope enum | `scope IN ('dashboard_api','pos','pos_operator','connector','password_reset','email_verify')`. Added only after a preflight of distinct existing scope values; stray value → STOP for owner (R3). |
| **CHECK connector-token consistency — DEFERRED (R3)** | `scope='connector'` iff `connector_registration_id IS NOT NULL`. **NOT shipped in `0021`** (018-SCHEMA, owner-decided 2026-06-06): a pre-existing legacy connector token (`scope='connector'`, `connector_registration_id IS NULL`) MAY exist in a live/staging env and would violate it. This is the R3 "defer if not safe" path — the FK + partial-unique ship now; the consistency CHECK is a **named follow-up pending a live backfill** that links every pre-existing connector token to a registration. The US4 guard enforces the linkage at runtime INDEPENDENTLY of this DB CHECK. The migration's synthetic-legacy-token back-compat test proves `0021` does not break such a row. |
| **Partial unique** at-most-one-active | `UNIQUE (connector_registration_id) WHERE scope='connector' AND revoked_at IS NULL` — immutable predicate (FR-010). Enforces at-most-one unrevoked connector credential per registration. |

Existing columns reused unchanged: `token_hash` (raw secret never stored), `issued_at`, `expires_at` (FR-012: bounded; default 90d, ceiling-capped — enforced in service, not the column), `revoked_at`, `tenant_id`.

## Entity 3 — Lifecycle audit (reuse `audit_events`)

One `audit_events` row per lifecycle action, written **in the same transaction** as the state change (the 017 `triggerRun` precedent):
`connector.registration.created` · `connector.registration.disabled` · `connector.credential.issued` · `connector.credential.rotated` · `connector.credential.revoked`.
Metadata = registration id, environment, credential id, actor. **Never** the raw secret or hash (FR-020/021).

## Usability predicate (enforced at the connector-auth boundary)

A presented connector credential is **usable iff** all hold (else non-disclosing 401, FR-015/016):
1. token row exists (hash match);
2. `expires_at > now()` (not expired);
3. `revoked_at IS NULL` (not revoked);
4. `scope = 'connector'`;
5. `connector_registration_id IS NOT NULL`;
6. the linked registration's `tenant_id` = the token's `tenant_id`;
7. the linked registration's `disabled_at IS NULL`.

Resolved via a **connector-only lookup** (R4) — the generic dashboard/POS token path is untouched. On success the guard attaches `{ registrationId, tenantId, environment }` to the request (FR-017).

## State transitions

**Registration:** `active` → `disabled` (logical, terminal in v1; re-enable is not in scope). Disable cascades to credential usability via predicate clause 7 (no row rewrite).

**Credential:** `active` → `revoked` (terminal). Issue creates `active`; rotate atomically revokes the prior active + creates a new active; expiry makes a still-`active`-flagged row unusable at the guard (clause 2) until maintenance revokes it.

## Observability

Unlabeled counter `connector_lifecycle_total` (or equivalent) in the shared `apps/api/src/observability/metrics/api.metrics.ts`, incremented per lifecycle action. No per-instance/tenant/secret label (FR-022a; cardinality + §XIV). Registered in the shared file's 3-place register, not a per-feature metrics file (010/015/017 precedent).

## Test surface (per §VI)

- Migration round-trip `0021` UP→DOWN→UP; the **two-allowlist regression** (append `0021` to `cli/migrate.spec` `EXPECTED_MIGRATIONS` + the new module to the barrel allowlist); re-call `ensureAppRole` after the migration.
- Preflight specs gating both CHECKs.
- RLS isolation sweep (wrong `app.current_tenant` → 0 rows; cross-tenant registration invisible).
- Lifecycle: issue / rotate (atomic + rollback-on-failure) / revoke / disable; at-most-one-unrevoked invariant (concurrent rotation → one active); raw-secret-once.
- Guard: full usability predicate + non-disclosing 401 + identity attachment; dashboard/POS path unaffected.
- Mass-assignment ban on registration create (tenant/id/disabled/created_by client-supplied → ignored/rejected, §XII).
- **Authorization (FR-005b + FR-005c):** the admin surface is gated by **two orthogonal checks** — a new **session-only guard** (rejects `principal.kind==="token"`, incl. `dashboard_api` bearer — FR-005c) AND `RolesGuard` `@Roles("owner","tenant_admin")` (FR-005b) + `TenantContextGuard`; default-deny → 404. Note 018 is STRICTER than the 014/017 precedent (which allows `dashboard_api`): `DashboardAuthGuard` is NOT used here. Tests cover the negatives: a non-admin session, **an owner/tenant_admin `dashboard_api` bearer** (denied by the session-only check even though role passes), and a POS credential are all denied on every lifecycle route; only a human owner/tenant_admin cookie session succeeds.
- Audit-in-transaction for every action; no raw secret in any log/response except the one issue/rotate body.
