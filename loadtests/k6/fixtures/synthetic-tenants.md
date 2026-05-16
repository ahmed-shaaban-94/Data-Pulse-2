# Synthetic tenants — fixture contract

> Track A first-slice, T431. **Documentation only.** This repo does NOT
> contain fixture data files. The expected row counts below describe what
> an operator must provision in their non-production load environment
> before running the k6 scripts. Real customer data MUST NOT be used.

## Why three synthetic tenants

FR-A-009 requires concurrent load across at least three tenants so that
RLS isolation and per-tenant pool behaviour are exercised under contention,
not just single-tenant throughput.

The k6 scripts hard-code three slugs:

- `tenant-load-A`
- `tenant-load-B`
- `tenant-load-C`

Each is shaped to a different real-world customer profile so the harness
exercises both light and heavy tenants in the same run.

## Per-tenant row-count profile (recommended)

| Tenant slug      | Profile       | Stores | Memberships (users) | Reason |
|------------------|---------------|--------|---------------------|--------|
| `tenant-load-A`  | Small / single| 2      | 5                   | Floor case; verifies the harness works for the most common low-touch customer shape. |
| `tenant-load-B`  | Mid           | 8      | 25                  | Typical mid-tier chain; balances RLS row volume with realistic governance churn. |
| `tenant-load-C`  | Heavy         | 50     | 150                 | Stress shape; verifies tenant-scoped reads stay within p95/p99 budgets when the row set is large. |

Profiles align with the store-count examples cited in plan §3.1.5 (2 / 8 / 50).

### Membership shape

Within each tenant:

- Roughly half the memberships use `store_access_kind: "all"`; the other
  half use `store_access_kind: "specific"` with a randomized subset of
  accessible stores. Mixing the two shapes exercises both branches of the
  store-access policy code path.
- Roles are distributed across `owner`, `admin`, `manager`, `viewer` in
  roughly 1 : 4 : 10 : 85 proportion (one owner per tenant; a handful of
  admins; some managers; majority viewers). This matches the documented
  governance pattern in Feature 001.

### Membership invite churn budget

Baseline and stress runs create new invitations every iteration (Flow 5,
`POST /api/v1/memberships/invite`). The operator should expect:

- ~100–300 new invitations per minute per tenant during baseline.
- Up to ~1000 new invitations per minute per tenant during stress.

The load-env reset job (see "Rebuild cadence" in the parent README) drops
all `invitee-*@example.invalid` invitations between runs so the table
doesn't grow without bound across multiple runs in the same week.

## Test users / tokens

Each synthetic tenant has one pre-provisioned load user:

| Tenant         | Env var that holds the email           | Env var that holds the password         | Tenant ID env var       |
|----------------|----------------------------------------|-----------------------------------------|-------------------------|
| `tenant-load-A`| `LOAD_USER_A_EMAIL`                    | `LOAD_USER_A_PASSWORD`                  | `LOAD_TENANT_A_ID`      |
| `tenant-load-B`| `LOAD_USER_B_EMAIL`                    | `LOAD_USER_B_PASSWORD`                  | `LOAD_TENANT_B_ID`      |
| `tenant-load-C`| `LOAD_USER_C_EMAIL`                    | `LOAD_USER_C_PASSWORD`                  | `LOAD_TENANT_C_ID`      |

Per-tenant primary store ID env vars (optional; the helper falls back to
`/context/me` when missing):

- `LOAD_STORE_A_ID`
- `LOAD_STORE_B_ID`
- `LOAD_STORE_C_ID`

Credentials are exported by the operator from a secrets store at run
time. They MUST NOT be checked in. They MUST NOT be reused outside the
load environment.

### Role requirement

Each load user MUST have a role that includes the permissions needed for
the six baseline flows:

- read own active context (`GET /api/v1/context/me`)
- switch active tenant / store (`POST /api/v1/context/tenant`, `/store`)
- list tenant members (`GET /api/v1/tenants/{tenant_id}/members`)
- create + update memberships (`POST /api/v1/memberships/invite`, `PATCH
  /api/v1/memberships/{id}`)

The simplest match is the `admin` role within the tenant. The load user
MUST NOT have platform-admin (`is_platform_admin`) — load runs should not
require elevated privileges.

## Invitation acceptance (Flow 5 second leg)

Baseline / stress run `POST /api/v1/memberships/invite` every iteration.
The matching `POST /api/v1/invitations/accept` call needs the
single-use token that the production system delivers by email.

The load environment SHOULD be configured to return the invite token
inline in the `createInvitation` response (a load-env-only behaviour) so
the accept leg can run in the same iteration. If the environment cannot
do this, baseline runs the invite leg only and skips accept (default
behaviour via `LOAD_SKIP_ACCEPT=1`).

Generated invitee emails follow the `invitee-<uuid>@example.invalid`
pattern so they can be swept up by the reset job. The `.invalid` TLD is
reserved by RFC 2606 and will never collide with real customer email.

## What is NOT in this repo

- No fixture JSON / SQL / seed files.
- No tenant UUIDs hard-coded anywhere.
- No load credentials (passwords, tokens, cookies).

Operators own the load environment lifecycle: provisioning, seeding,
reset, and credential management. The scripts in `loadtests/k6/` are the
only artifact this repo contributes.
