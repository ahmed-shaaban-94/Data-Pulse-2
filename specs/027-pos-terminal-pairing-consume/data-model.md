# Phase 1 Data Model — 027 POS Terminal-Pairing CONSUME

Grounded in the binding contract
`packages/contracts/openapi/pos-terminal-pairing.openapi.yaml` and the existing
device-auth model (`devices`, migration `0001`).

## THE DATA-MODEL DECISION: inline snapshot columns (NOT FK projection)

The 200 `TerminalPairResponse` requires, at consume time, a SOURCE for every one
of: `tenant_id`, `branch_id`, `terminal_id`, `terminal_label`, `branch_name`,
`branch_address`, `tenant_tax_registration_id`, `printer_vendor_id`,
`printer_product_id`, `printer_com_port` (+ the minted `device_token`).

**Verified against the live schema (`0000_initial.sql`):**
- `tenants` has `id, slug, name, status` — **NO `tax_registration_id` column.**
- `stores` has `id, tenant_id, code, name, is_active` — **NO `address` column.**
- No `terminal_label`, no printer-config table exists anywhere.

So there is **no existing column to FK-project** `branch_address`,
`tenant_tax_registration_id`, `terminal_label`, or the three printer fields from.
A pure-FK design is therefore impossible without **also** adding columns to
`tenants` / `stores` / a new printer table — which would be a SECOND-table /
multi-migration scope expansion (a stop condition) and would couple the pairing
slice to the tenant/store schema.

**Decision:** the `pairing_codes` row carries the full response binding as
**inline snapshot columns**, populated by the issuer (seeded directly for the
smoke). `tenant_id` and `store_id` are real FKs (they MUST reference live rows —
they are the RLS axis and the `devices`-row scope). Everything else
(`terminal_label`, `branch_name`, `branch_address`, `tenant_tax_registration_id`,
`printer_vendor_id`, `printer_product_id`, `printer_com_port`) is an inline value
the issuer pins at issue-time — exactly the contract's stated model: these fields
are "pinned at pair-time" terminal-resident copies, NOT live-fetched per sale.

**Why this is correct, not a shortcut:** the contract itself describes these as
*snapshot* values the terminal pins and never re-fetches. Snapshotting them on the
code row keeps the consume a single-table read with no cross-table join under a
bootstrap (no tenant context yet), keeps the slice to ONE migration, and makes the
issuance side (future) a pure INSERT into this one table. If a later slice
normalizes tenant tax-id / store address into their own tables, the issuer can be
changed to copy from them at issue-time — the consume contract is unaffected.

## Table — `pairing_codes` (migration `0024`, tail-appended after `0023`)

Tenant-scoped, RLS ENABLE + FORCE (the `devices`/connector precedent, with the
empty-GUC CASE guard from 0017–0021).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK DEFAULT gen_random_uuid() | |
| `tenant_id` | uuid NOT NULL → tenants ON DELETE RESTRICT | RLS axis |
| `store_id` | uuid NOT NULL → stores ON DELETE RESTRICT | the branch the device binds to (FK so it is a real store) |
| `code_hash` | BYTEA NOT NULL UNIQUE | `hashToken(pairing_code)` — never plaintext; UNIQUE = single index probe |
| `terminal_id` | uuid NOT NULL DEFAULT gen_random_uuid() | the stable terminal identity returned + persisted; survives re-pair |
| `terminal_label` | TEXT NOT NULL | CHECK non-empty; ≤64 (contract bound) |
| `branch_name` | TEXT NOT NULL | CHECK non-empty (contract: minLength 1) |
| `branch_address` | TEXT NOT NULL | CHECK non-empty |
| `tenant_tax_registration_id` | TEXT NOT NULL | CHECK non-empty (string for ETA forward-compat) |
| `printer_vendor_id` | TEXT NOT NULL | CHECK `~ '^0x[0-9A-Fa-f]{4}$'` (contract pattern) |
| `printer_product_id` | TEXT NOT NULL | CHECK `~ '^0x[0-9A-Fa-f]{4}$'` |
| `printer_com_port` | TEXT NULL | CHECK NULL OR non-empty; nullable per contract |
| `status` | TEXT NOT NULL DEFAULT 'pending' | CHECK `IN ('pending','used','cancelled')` |
| `expires_at` | TIMESTAMPTZ NOT NULL | redeemable only while `now() < expires_at` |
| `attempt_count` | INTEGER NOT NULL DEFAULT 0 | per-code attempt accounting → 429 (FR-008) |
| `last_attempt_at` | TIMESTAMPTZ NULL | back-off window anchor |
| `device_id` | uuid NULL → devices ON DELETE RESTRICT | the device minted on the success that burned this code (audit trail; NULL while pending) |
| `used_at` | TIMESTAMPTZ NULL | set on the burn |
| `created_at` / `updated_at` | TIMESTAMPTZ NOT NULL DEFAULT now() | `updated_at` trigger |

**No money / PII / secret-plaintext column.** `code_hash` is a hash, not a secret;
the minted `device_token` is NEVER stored on this row (only its hash lands in
`devices.token_hash`).

### Rate-limit model (FR-008)
The contract narrative says rate-limiting is "at the edge proxy (per `pairing_code`
+ per source IP)". This slice implements the **per-code** half durably:
`attempt_count` is incremented on every redemption attempt that reaches a code
row; once it exceeds the threshold within the back-off window the consume returns
429 + `Retry-After`. Per-**IP** limiting is delegated to the edge proxy (documented,
not re-implemented in the app — the app has no shared IP store and the contract
explicitly sites IP limiting at the edge).

## Relationship to `devices` (the credential gate)
On success, ONE `devices` row is inserted (`id = terminal_id` so the device and
terminal identities coincide and the read-down principal's `storeId` matches the
paired branch): `token_hash = hashToken(rawToken)`, `tenant_id`, `store_id`,
`label = terminal_label`. `PosDeviceAuthGuard` →
`DeviceRepository.findActiveByAttestation(rawToken)` hashes the bearer and probes
`devices.token_hash WHERE revoked_at IS NULL` → resolves `(tenant_id, store_id)`.
The returned `device_token` therefore authenticates the read-down routes
immediately. `branch_id` in the response == `store_id`; `terminal_id` == the
`devices.id`.

## State transitions
`pending --(successful pair)--> used` (guarded conditional UPDATE
`WHERE id = $1 AND status = 'pending'` — race-safe; loser → 410).
`pending --(admin)--> cancelled` (issuance-side; consume treats `cancelled` as 410).
No transition out of `used`/`cancelled`.
