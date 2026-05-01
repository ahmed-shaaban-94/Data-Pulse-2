# Quickstart — Foundation Verification

**Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md)
**Audience**: reviewers and future implementers.
**Status**: Documentation only. No code is invoked from this file in the
current step.

This is the **acceptance walk-through** for the foundation. It describes
what a verifier should be able to do once `/speckit-tasks` produces the
implementation. It is intentionally written at the behavior level — no
language- or framework-specific commands appear here.

---

## 0. Preconditions

- A running PostgreSQL 16+ instance.
- A running Redis 7+ instance.
- The migration set described in [`data-model.md`](./data-model.md) §15 has
  been applied; RLS policies are enabled on every tenant-owned table.
- The API server and one worker are running.
- Two empty test tenants `acme` and `globex` exist (created by a platform
  admin or a seed routine).
- Each tenant has at least one store; `acme` has stores S1, S2; `globex`
  has store G1.
- Three test users exist:
  - **Alice** — Tenant Admin in `acme`, no membership in `globex`.
  - **Bob** — Store Staff in `acme` with access to **S1 only**.
  - **Carol** — Tenant Admin in `globex`, no membership in `acme`.

---

## 1. Sign-in and active context

1. Alice signs in via `POST /api/v1/auth/signin` with valid credentials.
   - Response: 200, session cookie set.
   - Body lists Alice's memberships (one: `acme`).
2. Alice queries `GET /api/v1/context/me`.
   - Active tenant is auto-set to `acme` (only one membership).
   - Active store is `null`.
3. Alice calls `POST /api/v1/context/store` with `S1`.
   - Response: 200; active store is now `S1`.
4. Alice calls `POST /api/v1/context/store` with `G1`.
   - Response: **404** (G1 belongs to `globex`, not the active tenant).
   - Verifier confirms the response does **not** distinguish "store
     not found" from "store in another tenant" (FR-ISO-4).

**Pass criteria**: behaviors above match.

---

## 2. Cross-tenant isolation (the critical test)

1. Carol (logged in to `globex`) attempts `GET /api/v1/stores/{S1}` —
   passing the UUID of an `acme` store directly.
   - Response: **404**. No body data leaks the existence of S1.
2. Verifier opens a database client with a connection where
   `app.current_tenant` is set to `globex`'s UUID and runs:
   `SELECT * FROM stores WHERE id = '<S1 uuid>';`
   - Result: **0 rows**. RLS blocks the read at the database layer.
3. Verifier sets `app.current_tenant` to `acme`'s UUID on the same
   connection and runs the same query.
   - Result: **1 row**. Confirms the policy is keyed on the GUC, not the
     connection identity.

**Pass criteria**: SC-1 and FR-ISO-1/4 hold.

---

## 3. Cross-store isolation within a tenant

1. Bob (Store Staff in `acme`, access to **S1 only**) signs in.
2. Bob switches active store to `S1` — succeeds.
3. Bob tries `GET /api/v1/stores/{S2}` — passing `acme`'s S2.
   - Response: **404**. S2 exists in Bob's tenant, but Bob doesn't have
     access; the response is indistinguishable from "not found."
4. Bob calls `POST /api/v1/context/store` with `S2`.
   - Response: **404**.

**Pass criteria**: SC-2 and FR-ACCESS-2 hold.

---

## 4. Backend authority — frontend-bypass probe

1. Bob signs in successfully (Store Staff role).
2. The verifier crafts a raw `POST /api/v1/memberships/invite` request
   (a tenant-admin operation) using Bob's session cookie — bypassing any
   frontend that would have hidden the action.
   - Response: **403**. The backend rejects the request based on Bob's
     role, not on a frontend hint.

**Pass criteria**: SC-4 and FR-ROLE-5 hold.

---

## 5. Invitation flow end-to-end

1. Alice (Tenant Admin in `acme`) calls
   `POST /api/v1/memberships/invite` with `{ email: "dan@example.com",
   role_code: "store_staff", store_access_kind: "specific",
   store_ids: ["<S1>"] }`.
   - Response: 201; invitation created.
   - Worker enqueues an email-send job (verifier inspects worker queue or
     a test stub).
2. Verifier extracts the accept token and calls
   `POST /api/v1/invitations/accept` with `{ token: "...", password: "...",
   display_name: "Dan" }`.
   - Response: 200; user `Dan` is created, membership row exists for
     `(Dan, acme)` with role `store_staff` and access only to S1.
3. Dan signs in. Dan can read store S1 but receives 404 for S2.

**Pass criteria**: SC-6 (invite-to-signin in under 5 minutes) and FR-TEN-3
hold.

---

## 6. Audit completeness

1. Verifier queries `GET /api/v1/audit/events` (as Alice, tenant-admin in
   `acme`).
2. Confirms entries exist for:
   - Each sign-in (success and failure).
   - The invitation creation and acceptance.
   - The role/store-access change Alice made earlier.
   - Cross-tenant access attempts by Carol against `acme` (logged with
     `tenant_id = acme`).
3. Confirms entries do **not** include credentials or tokens (FR-AUDIT-3).

**Pass criteria**: SC-7 and FR-AUDIT-1/3 hold.

---

## 7. Soft-delete and retention

1. Platform admin soft-deletes `globex` (24h before retention window
   default; window is 30 days).
2. Carol's session is invalidated; her sign-in attempts return 401.
3. Direct `GET /api/v1/tenants/{globex}` from a non-platform-admin
   returns 404.
4. Within 30 days, platform admin can restore `globex` (a future endpoint;
   implementation not in this milestone — verifier confirms the data is
   still in Postgres with `deleted_at IS NOT NULL`).
5. After 30 days, hard-delete is permitted via a platform-admin script
   that records an audit event.

**Pass criteria**: FR-TEN-5 holds.

---

## 8. POS-seam thought experiment (SC-8)

> No POS endpoint exists in this milestone. This step verifies the seam.

1. Imagine a hypothetical `POST /api/pos/v1/orders` endpoint that submits
   a sale from a POS device.
2. Walk through how it would attach to the foundation:
   - The device authenticates via an `auth_tokens` row with
     `scope = 'pos'`, `tenant_id = acme`, `store_id = S1`,
     `device_id = ...` (column already reserved in
     [`data-model.md`](./data-model.md) §10).
   - The endpoint runs through the same tenant-context middleware that
     sets `app.current_tenant`. RLS protects all reads/writes.
   - The request carries `Idempotency-Key`. The `idempotency_keys` table
     (data-model §13) stores the result keyed by `(tenant_id, store_id,
     client_id, key)` — already exists.
   - The endpoint enqueues any heavy follow-on work to a worker
     (Constitution V).
3. Confirm the walk-through requires **zero schema changes** to the
   foundation. The seam is honest.

**Pass criteria**: SC-8 holds.

---

## 9. Failure-mode probes

1. **Redis cache is wiped mid-session.** Alice's next request still
   succeeds (read-through cache; Postgres is the source of truth).
2. **Active tenant is unset on a tenant-scoped request.** Response: 401.
   No fallback to "first tenant found" (FR-CTX-4).
3. **Concurrent context switch + in-flight read.** A user switches active
   tenant while a long-running request is mid-flight. The in-flight
   request continues with the tenant context resolved at its start; the
   next request observes the new context. (Plan PR-4 mitigation.)
4. **Membership revoked while user is online.** Within ≤5 minutes
   (FR-AUTH-6 / FR-ACCESS-4 bound), the user's session is invalidated.
   Verifier shrinks the bound for the test by triggering a cache
   invalidation tick.

**Pass criteria**: failure modes match the documented behavior; no leaks.

---

## 10. Sign-off

The foundation is "verified" when steps 1–9 above all pass against the
implemented system. Until then, this quickstart serves as the acceptance
contract that `/speckit-tasks` work must satisfy.

---

**End of quickstart.**
