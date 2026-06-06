# Design — 018 Connector Boundary Hardening v1 (DP2-owned)

**Date:** 2026-06-06
**Status:** Brainstorm design, approved section-by-section. Pre-spec.
**Owning repo:** Data-Pulse-2 (DP2-side; coordinated with the ERPNext connector repo).
**Spec number:** `018-connector-boundary-hardening` (next free DP2 number; `016` is on-hold, `017` closed).

---

## One-sentence definition

018 = **Connector Boundary Hardening v1**: define the safe pilot boundary between Data-Pulse-2 and the ERPNext Connector now that the connector is real and posting — focused on **connector identity, credential lifecycle, scopes, registration, and the boundary contract** — **not** live stock read and **not** fiscal.

## Trigger (why now)

The connector is no longer theoretical: a real Frappe app (`Retail-Tower-ERP-Next-Connector`), Connector Settings, a `dp2_token`, poller activation (connector PR #23), and a working posting path. The next risk is no longer *"can it post?"* (017-VERIFY proved the DP2 side) but *"can we safely operate it for a tenant/pilot?"* Today the seam works, but connector identity + credentials are too loose for pilot operations:

- connector auth is a generic `auth_tokens` row with a free-TEXT `scope` (no DB constraint);
- no formal connector registration lifecycle;
- no operator-safe issue / rotate / revoke flow;
- no stable connector-instance identity (no connector id, ERPNext site label, environment);
- no boundary document fixing which future surfaces belong to DP2 vs the connector.

## Repo ownership

**Primary: Data-Pulse-2** — DP2 owns the contract/orchestration boundary, tenant authority, token issuance, the auth guard, and connector-facing API policy. A "Data-Pulse 018" spec can only own **DP2's side**. The connector-side counterpart (likely connector spec **007**) consumes the boundary 018 defines and is authored **after** 018, never first.

---

## Verified current state (grounded against the code, 2026-06-06)

- `auth_tokens` already carries the credential primitives: `token_hash` (bytea, unique, never raw), `issued_at`, `expires_at`, `revoked_at`, `tenant_id` (RLS), active-token partial index. (`packages/db/src/schema/auth_tokens.ts`)
- `scope` is **free TEXT, no DB CHECK**; `connector` is one value of the TS `BearerAuthScope` union — a type-only addition (015), nothing constrains it at the DB level.
- `ConnectorAuthGuard` (`apps/api/src/auth/connector-auth.guard.ts`) is **binary**: delegates to `AuthGuard`, then allows iff `principal.kind === "token" && principal.scope === "connector"`. No instance identity, no registration linkage.
- The connector consumes `/api/connector/v1/erpnext/postings` feed/ack (012 `posting-feed.yaml`); the DP2 controller is `erpnext-posting.controller.ts`.
- No connector-instance identity and no operator credential-lifecycle surface exist.

---

## Section 1 — Data model (load-bearing) — APPROVED

### New `[GATED]` table: `connector_registration` (stable DP2-side connector identity)

Identity-focused and **minimal** — no health/heartbeat/lag/last-seen (those are 020).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | the `connector_id` operators / audits / 020 / 019 / 023 reference |
| `tenant_id` | uuid NOT NULL → tenants | RLS axis; a registration belongs to exactly one tenant |
| `display_name` | text NOT NULL | operator label; **CHECK non-empty/trimmed** |
| `erpnext_site_ref` | text NOT NULL | the ERPNext site label/ref (NOT a secret) |
| `environment` | text NOT NULL | **CHECK in (`dev`,`staging`,`pilot`,`prod`)** |
| `created_at` / `created_by` | timestamptz / uuid | provenance |
| `disabled_at` / `disabled_by` | timestamptz NULL / uuid NULL | logical disable; cascades to credential usability at the guard |

- **RLS fail-closed** (empty-GUC CASE guard), mirroring `0019`/`0020`. **No secret column** — credentials live only in `auth_tokens`. BUSINESS-class, §XIV (no PII).
- **Uniqueness `(tenant_id, environment, erpnext_site_ref)`: OPEN QUESTION — left OUT of v1**, documented. Add only if the owner confirms one tenant must not register the same ERPNext site twice in the same environment. Not assumed.

### `auth_tokens` change — link only (NOT connector metadata)

- Add **`connector_registration_id uuid NULL`**, FK → `connector_registration(id)`, **`ON DELETE RESTRICT`**. Nullable: non-connector scopes don't use it. This is the *only* shared-table change — a link, not metadata (that is what keeps us out of rejected Option B).

### DB CHECKs — preflight-gated, never blind

Both desired end-states, each gated on a preflight that **STOPs for owner decision on stray/legacy rows** (never silent-normalize):

1. **Scope CHECK** — pin `scope` to (`dashboard_api`,`pos`,`pos_operator`,`connector`,`password_reset`,`email_verify`). Preflight = distinct existing scope values. Stray value → STOP.
2. **Connector-token consistency CHECK** — `scope='connector'` **iff** `connector_registration_id IS NOT NULL`. Preflight = existing connector tokens. If legacy connector tokens exist: either backfill a legacy registration per (tenant, environment) then add the CHECK in the same gated slice, OR add the FK first / document legacy NULLs / make the CHECK a named follow-up.

Preference: preflight → if safe, backfill-then-CHECK in the same gated slice; if not safe, CHECK becomes a named follow-up. The decision is recorded, not forced.

### Usability rule (enforced at the connector-auth boundary, not the generic repo)

A connector credential is usable **iff**: token exists · not expired · not revoked · `scope='connector'` · `connector_registration_id` present · registration belongs to the token's tenant · registration `disabled_at IS NULL`. Implemented via a **connector-specific lookup** (`findActiveConnectorCredentialByRawToken`-style) so dashboard/POS token behavior is untouched.

---

## Section 2 — Credential lifecycle flows — APPROVED

**Decision: immediate revoke + at-most-one-active credential per registration. Atomic replacement, no grace window in v1.**

- **Register** → create a `connector_registration` row. No credential yet. Audit `connector.registration.created`.
- **Issue** → mint a connector-scoped `auth_tokens` row with `connector_registration_id` set, `expires_at` per policy, `token_hash` stored. **Raw token returned exactly once**; never persisted, never logged. Audit `connector.credential.issued`.
- **Rotate** (atomic, one transaction): (1) verify registration exists, belongs to tenant, not disabled; (2) revoke existing unrevoked connector credential(s) for that registration; (3) insert the new connector-scoped token linked to the **same** registration; (4) audit `connector.credential.rotated`; (5) return the new raw token once. **If the insert fails, the transaction rolls back and the old credential remains active.** Old token unusable immediately after success.
- **Revoke** → set `revoked_at` on one credential. Registration stays active. Audit `connector.credential.revoked`.
- **Disable registration** → set `disabled_at`/`disabled_by`. All linked credentials become unusable **at the guard** (logical). Token rows preserved for audit — **never cascade-delete**. Audit `connector.registration.disabled`.

**At-most-one-active invariant (DB-enforced):** `UNIQUE (connector_registration_id) WHERE scope='connector' AND revoked_at IS NULL` — all-immutable predicate (avoids the `now()`-not-IMMUTABLE partial-index trap). Expiry is **not** in the constraint: the guard rejects expired tokens; lifecycle maintenance revokes them. Two unrevoked connector credentials for one registration are disallowed in v1.

**Future (not 018):** if pilot ops prove zero-downtime rotation is needed, a grace-window design is its own later follow-up; 020 adds status/last-seen/lag for better rotation feedback.

---

## Section 3 — Guard + identity resolution — APPROVED

- Tighten `ConnectorAuthGuard`: beyond `scope='connector'`, resolve + validate the full **usability rule** (Section 1) via the **connector-specific lookup** — does NOT broaden the generic token repo (dashboard/POS untouched).
- On success, attach the resolved connector identity to the request (`request.connector = { registrationId, tenantId, environment }`) so handlers + audit know *which instance* called — the thing missing today.
- On any failure (expired / revoked / disabled registration / missing link) → **non-disclosing 401** (never leaks which condition failed).
- Tenant from the principal/registration, **never body/query** (§XII), unchanged.
- **No sub-scopes in v1** — the single `connector` scope is the gate. Least-privilege for future surfaces (019/023) is a *documented boundary*, not implemented sub-scope machinery (YAGNI).

---

## Section 4 — Admin surface + audit + boundary conformance doc — APPROVED

### Admin surface (operator-facing, `cookieAuth`/`DashboardAuthGuard` — human Tenant Admin, the 013/014/017 pattern)

- Operations: `register` / `list` / `disable` registrations; `issue` / `rotate` / `revoke` credentials.
- Raw token returned **once** on issue/rotate; never on list/get. List/get expose registration identity + credential *status* (issued/expires/revoked timestamps) — **never** the hash or raw token.
- **REST (a `[GATED]` OpenAPI contract) vs CLI/seed admin path is a PLAN-TIME decision.** The spec names the operations + their auth/audit/non-disclosure contract; the plan proposes the surface and **waits for `[GATED]` approval** if it's an OpenAPI/migration change (honors the no-contract/migration-without-approval non-goal).

### Audit

Every lifecycle action writes an `audit_events` row **in the same transaction** as the state change (the 017 `triggerRun` precedent): `connector.registration.created` / `.disabled`, `connector.credential.issued` / `.rotated` / `.revoked`. Metadata = registration id, environment, credential id, actor — **never** the raw token or hash.

### Boundary conformance doc (document the existing 012 boundary; do NOT redesign it)

A spec artifact pinning the existing connector boundary as the contract of record: `/api/connector/v1/erpnext/postings` feed/ack — `connectorBearer`-only (now registration-linked), `Idempotency-Key` required on ack, replay → `200 replayed`, canonical error envelope, non-disclosing 404/401, no-PII/no-money payloads. Plus the **surface-ownership table** (below).

### Surface-ownership boundary (the A–E table)

| | Surface | Owner / spec | 018 stance |
|---|---|---|---|
| A | Existing posting feed/ack | 012 / 015 (shipped) | **Document, do not touch** |
| B | Connector health/status API | **020** (future) | References `connector_registration`; out of 018 |
| C | Live ERPNext-Bin stock view | **019** (= the 017-deferred `017-STOCK-VIEW-CONTRACT`) | Authorizes by `connector_registration`; out of 018 |
| D | Sales-posting command contract | **023** (if a gap over 012/015 is proven) | Reuses the identity boundary; out of 018 |
| E | Tax / fiscal | **016** (on-hold) | Deferred; out of 018 |

---

## Section 5 — Follow-up handoffs, testing, scope fence — APPROVED

### Follow-up slices 018 names (hands off, does not build)

- **020 — connector health/status API:** references `connector_registration.id`; adds last-seen/lag/heartbeat (the status fields kept out of 018). Better rotation feedback once it lands.
- **019 — live ERPNext-Bin stock-view contract:** **019 IS the artifact 017 deferred as `017-STOCK-VIEW-CONTRACT`** — one identity, cross-linked from the 017 docs. Authorizes by `connector_registration`.
- **023 — sales-posting command contract** (only if a gap over 012/015 is proven): reuses the identity boundary.
- **029 — scheduled reconciliation** (= 017's `017-SCHEDULED-RUNS`): unaffected by 018, noted for completeness.
- **Connector-side spec 007** (connector repo): consumes the DP2 boundary; authored after 018, never first.

### Testing strategy (WSL Testcontainers, repo standard)

- Migration round-trip (UP→DOWN→UP) for `connector_registration` + the `auth_tokens` FK; the **two-allowlist regression** — append to `cli/migrate.spec` `EXPECTED_MIGRATIONS` + the catalog/auth barrel (the #447/#487-class hosted-CI break); re-call `ensureAppRole` after the migration.
- **Preflight specs** (distinct scope values + existing connector tokens) gating both CHECKs.
- Lifecycle: issue / rotate (atomic, rollback-on-failure) / revoke / disable; the at-most-one-unrevoked invariant (DB-enforced); raw-token-returned-once.
- Guard: full usability rule + non-disclosing 401 + identity attachment; **isolation sweep** (RLS fail-closed, cross-tenant → 0 rows).
- Audit-in-transaction for every lifecycle action; no raw token in any log/response except the one issue/rotate body.

### Scope fence (non-goals = hard stops)

No live ERPNext Bin read (019) · no scheduled reconciliation (029) · no 016 tax/fiscal · no POS/Console change · no outbound ERPNext HTTP from DP2 · no connector-repo runtime changes · **no migration/OpenAPI authored without explicit `[GATED]` approval at plan time** · no redesign of the working 012 feed/ack.

---

## Success criteria

- We can explain how a tenant connector is registered.
- We can issue, rotate, and revoke connector credentials safely (raw token shown once; immediate-revoke rotation; at-most-one active per registration).
- We can prove only connector-scoped, registration-linked, non-disabled credentials access connector endpoints (everything else → non-disclosing 401).
- We have an explicit, documented boundary between A) existing posting feed/ack, B) future health/status (020), C) future live stock view (019), D) future sales-posting command (023), E) deferred tax/fiscal (016).
- The spec outputs clear follow-up slices: 020 health/status, 019 stock-view contract, 023 sales-posting command (if needed), optional connector-side 007.

---

## Open questions carried into the spec

1. **`(tenant_id, environment, erpnext_site_ref)` uniqueness** — include only if the owner confirms a tenant must not register the same site twice per environment. Left out of v1 by default.
2. **Admin surface form** — REST `[GATED]` OpenAPI vs CLI/seed — resolved at plan time; gated if it touches a forbidden path.
3. **Preflight outcomes** — both DB CHECKs depend on preflight results; stray/legacy rows are a STOP-and-raise, not an auto-fix.
