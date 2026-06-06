# Quickstart — 018 Connector Boundary Hardening v1

How to exercise + verify 018 once it ships. DB-backed specs run under **WSL Testcontainers** (`reference_007_test_env`); `MIGRATION_TEST_ALLOW_SKIP=1` for Docker-less local runs.

## Prerequisites (on `main` after merge)

- The `[GATED]` `0021` migration: `connector_registration` + the `auth_tokens.connector_registration_id` FK + the (preflight-gated) CHECKs + the at-most-one-unrevoked partial-unique.
- The existing connector posting surface (`/api/connector/v1/erpnext/postings` feed/ack) + `ConnectorAuthGuard` (tightened).
- A tenant + a Tenant Admin session (cookieAuth) for the admin flows.

## US1 🎯 — register an instance + issue its first credential

1. As a Tenant Admin, register a connector instance: `{ display_name, erpnext_site_ref, environment: pilot }`.
2. **Expect**: a registration row for the tenant, listable, no credential yet. A duplicate `(environment, erpnext_site_ref)` for the same tenant → clear error (FR-005a).
3. Issue a credential for the registration.
4. **Expect**: the raw secret returned **exactly once** in that response; a follow-up list/get shows credential status (issued/expires/revoked) but **never** the secret or hash.
5. Configure a connector (or a test client) with the raw secret; call the connector posting feed → accepted, and the platform identifies the calling instance.

## US2 — rotate + revoke

1. Rotate the credential.
2. **Expect**: new raw secret returned once; the old secret rejected on the **next** connector request; never two valid secrets at once (at-most-one-active). Force the issue step to fail → transaction rolls back, old secret still works (no lockout).
3. Revoke a credential → rejected on connector endpoints immediately; the registration stays active.
4. **Concurrency**: two simultaneous rotations → exactly one active credential afterward (the partial-unique serializes).

## US3 — disable an instance

1. Disable the registration.
2. **Expect**: its credential rejected on the connector endpoints immediately (predicate clause 7); the registration + credential rows still present (logical disable, no deletion — FR-014).

## US4 — guard enforcement (the security backbone)

1. Present each disallowed credential to a connector endpoint: a human dashboard session, a POS credential, an expired connector token, a revoked one, an unlinked one (`connector_registration_id` NULL), one whose registration is disabled, and a cross-tenant probe.
2. **Expect**: every one rejected with an **identical non-disclosing 401** (no hint which condition failed). A valid, active, linked, non-disabled credential → accepted + instance identified.
3. **Regression**: dashboard + POS authentication behavior unchanged (FR-019).

## US5 — boundary-of-record doc

1. Read `contracts/connector-boundary.md`.
2. **Expect**: it states the existing 012 feed/ack auth / idempotency / replay / error / non-disclosure rules (without redesigning them) + the A–E surface-ownership table (health/status→020, live stock view→019, sales-posting command→023, tax/fiscal→016).

## Observability

- Each lifecycle action increments the unlabeled `connector_lifecycle_total` counter in the shared `api.metrics.ts`; no per-instance/tenant/secret label. Verify by mocking the emission helper (the read-down/015/017 signals.spec idiom).

## Gate checks before each PR

```
pnpm -r run build                                   # tsc strict, all packages
wsl -e bash -lc "pnpm --filter @data-pulse-2/api test -- connector"
wsl -e bash -lc "MIGRATION_TEST_ALLOW_SKIP=0 pnpm --filter @data-pulse-2/db test -- --runInBand 0021-connector-registration"
# the [GATED] 0021 migration + admin OpenAPI (iff REST) are owner-approved (2026-06-06);
# preflight stop-on-stray-rows still applies at SCHEMA time
```
