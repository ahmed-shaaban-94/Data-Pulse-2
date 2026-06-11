# Feature Specification: POS Auth Boundary & Operator Lifecycle

**Feature folder (speckit nominal)**: `028-pos-auth-boundary-and-operator-lifecycle`

> **Numbering note.** The dispatch named this feature `027-...`. At specify time
> `specs/027-pos-terminal-pairing-consume/` already exists and is a **different,
> shipped feature** (the `posPairTerminal` device-pairing CONSUME endpoint,
> migration `0024`). Per the repo's monotonic spec-numbering convention and the
> documented "resolved by authoring order" precedent (020/021 migration clash),
> this feature takes the next free slot, **`028`**. No 027 artifact is reused,
> renamed, or overwritten. See §3 Non-goals and the boundary references below.

**Created**: 2026-06-11

**Status**: Draft — SPECIFY ONLY. No code, migrations, OpenAPI, or runtime
changes are produced by this feature. This document defines the **target**
authentication and operator-lifecycle model and explicitly catalogues where the
**shipped runtime** currently diverges from it.

**Input**: Owner/program dispatch — define a provider-neutral authentication and
operator-lifecycle model for Retail Tower POS, covering Console-managed user
lifecycle, external identity-provider authentication, Data-Pulse authorization
and session authority, POS online sign-in, POS offline unlock, sale-sync
authorization, device pairing/revocation, password vs PIN reset, revocation
while offline, and identity-provider independence (anti-lock-in).

---

## Clarifications

### Session 2026-06-11 — inherited from the merged cross-repo boundary (Orchestrator 028)

> The project-wide boundary-of-record **`Retail-Tower-Orchestrator` `docs/specs/028-project-auth-identity-access-boundary/`** merged on its `origin/main` (PR #85 / `76cfcc3`, clarified; gate **G10** wired via PR #86). That spec is the umbrella this DP-2-backend slice sits under; its signed decisions resolve the matching open questions here. Decisions below are **adopted, not re-litigated** — DP-2 028 is the DP-2 implementation slice of the same boundary.

- Q: OQ-8 — sale-sync credential reconciliation (Option-Y provider JWT + `X-Device-Attestation` vs the target `pos_operator`)? → A: **Option-Y is a v1 bridge.** Target = an **internal, provider-neutral operator-authorization envelope minted at sign-in** — which IS the `pos_operator` credential the canonical scope guard expects (reconciling issuance↔use). DOC-3's shape follows: the documented sale-sync scheme becomes the internal operator scheme, not the raw provider JWT. Implementation is later `[GATED]` DP-2 work.
- Q: OQ-6 — provider-neutral identity link vs `users.clerk_user_id`? → A: **Neutral identity link in v1** (`provider_key`/`issuer`/`subject` → local `user_id`); `clerk_user_id` is reclassified as a **bridge column behind it**, not the long-term join key.
- Q: OQ-7 — provider migration scope? → A: **Architecture-readiness only, NOT v1 build.** The §13 port + identity link make a future Auth0/Keycloak/OIDC switch a per-adapter change; no second provider integration is built in v1. A staged dual-link plan is authored only if/when a switch is scheduled.
- Q: OQ-1 — offline grace period? → A: **Tenant-configurable, default 24h** within a hard platform ceiling (a Console policy knob; default applies when unset).
- Q: OQ-5 — offline-sale sync when the original operator is unavailable / expired? → A: **Sync on the still-valid device trust + the sale's captured-time operator/device/store provenance** — no forced original-operator re-auth; post-revocation actions still refused; the sale fact is never rewritten. Manager-supervised sync is not required for v1.

Still open (match the Orchestrator's still-open set): OQ-2 (offline manager override), OQ-3 (PIN complexity / retry-lock), OQ-4 (multi-terminal vs takeover). These are plan-phase / pilot-policy and non-blocking.

---

## 1. Summary

Retail Tower spans five repositories (Data-Pulse-2 backend / source-of-truth,
the Retail-Tower-ERPNext-Connector, the POS-Pulse Windows terminal, the
Retail-Tower-Console admin SPA, and the Retail-Tower-Orchestrator), all
integrating only through Data-Pulse-2's pinned OpenAPI contracts. As live POS
rollout, returns/refunds, and Console admin work approach, the authentication
boundary must be **explicit and provider-neutral** so that cashier operations,
offline POS behaviour, password reset, device pairing, and provider independence
are well-defined *before* further build-out.

In business terms: a store manager needs to create a cashier, that cashier needs
to sign in on a paired terminal, keep ringing sales when the network drops, and
be cleanly disabled or have a device revoked — all without Retail Tower being
permanently welded to one identity vendor, and without any one credential being
usable where it should not be. Today several of these flows work, one of them
(sale-sync authentication) ships in a form that **contradicts** the intended
boundary, and several (offline unlock, local PIN, provider neutrality) are not
yet built. This spec states the target model, anchors it to the shipped code as
evidence, and names the drift to be corrected by later, separately-specified
work.

### Core principle (stated once, governs everything below)

> **Identity provider authenticates the human.**
> **Data-Pulse authorizes the work.**
> **Console manages operational access.**
> **POS runs the cashier terminal workflow and offline unlock.**

ERPNext is **not** the cashier identity system and is never in the POS auth path.

---

## 2. Goals

- **G1** — Make credential boundaries explicit: every credential has exactly one
  issuer, one validity surface, and one thing it authorizes; no credential is
  interchangeable with another.
- **G2** — Support cashier **online** sign-in on a paired terminal, bridging
  external identity proof + device attestation into an internal POS operator
  session.
- **G3** — Support **offline** POS unlock *after* a prior successful online
  verification, using a local PIN + cached operator profile (never cloud-password
  authentication).
- **G4** — Keep **user and role management** in Console / Data-Pulse, not in the
  identity-provider vendor dashboard.
- **G5** — Keep **passwords, MFA, and email verification** in the identity
  provider; Retail Tower never stores or verifies cloud passwords.
- **G6** — Prevent Clerk-specific (or any single-vendor) semantics from leaking
  into POS **business authorization** or route **contracts**.
- **G7** — Ensure **sale-sync** is authorized by an internal POS-operator
  authority derived inside Data-Pulse — **target:** an internal `pos_operator`
  credential, **not** a raw external-provider JWT. (See §6/§7/§9 and the drift
  note — the shipped runtime currently uses a raw Clerk JWT for this surface.)
- **G8** — Ensure POS **catalog read-down** can run with device auth alone, with
  no cashier signed in (already shipped — see §6/§7 evidence).
- **G9** — Define safe, bounded, auditable behaviour for password reset, PIN
  reset, account/device revocation, expired sessions, and offline work.
- **G10** — Define a provider-neutral identity-mapping and adapter concept so a
  future migration to Auth0 / Keycloak / generic OIDC does **not** require
  rewriting POS authorization rules.

---

## 3. Non-goals

- **NG1** — No custom password database in Data-Pulse v1. Passwords stay with the
  identity provider.
- **NG2** — No ERPNext-managed POS cashier identity.
- **NG3** — No direct POS → ERPNext authentication. POS never talks to ERPNext;
  the connector is the only ERPNext client and uses its own machine bearer.
- **NG4** — No direct POS use of provider admin APIs. POS never holds provider
  admin credentials.
- **NG5** — No offline cloud-password reset.
- **NG6** — No sale-sync authorized by a **device token only** (a device token
  proves terminal trust, not sale ownership).
- **NG7** — No raw provider JWT as the **long-term** sale-sync credential. (Its
  current use is documented as a v1 legacy bridge to be corrected — §6, §13, §15;
  this spec does not bless it as the end state.)
- **NG8** — No shared cashier accounts. One human → one identity → one operator.
- **NG9** — **No implementation, code, migration, OpenAPI, package, lockfile, CI,
  or runtime-config work in this feature.** This is SPECIFY-ONLY.
- **NG10** — This feature does **not** redefine device-pairing CONSUME (shipped in
  `027-pos-terminal-pairing-consume`) nor returns/reversal (`026-returns-reversal-contract`).
  It references their boundaries; it does not re-spec them.

---

## 4. Actors

| Actor | Description |
|---|---|
| **Platform owner / admin** | Retail Tower operator with cross-tenant authority; manages platform-level configuration. Internal role `owner`. |
| **Tenant admin** | Administers a single tenant: creates users, assigns roles/stores, initiates resets, disables users. Internal role `tenant_admin`. |
| **Store manager** | Manages a store's operators and devices; may authorize sales and (per open question) offline overrides. Internal role `store_manager`. |
| **Cashier / operator** | Floor staff who signs in on a POS terminal and rings sales. Internal role `store_staff` (a.k.a. cashier). Eligibility to ring manager/admin-authorized sales is role-gated (see §9). |
| **POS terminal / device** | A registered Windows terminal whose `device_token` is paired to a specific `(tenant, store)`. Holds local secret storage, a local outbox, and an offline cashier-unlock surface. |
| **Data-Pulse backend** | NestJS api + worker. The authorization authority and session authority; owns tenant membership, store access, POS eligibility, internal tokens, device binding, audit. |
| **Retail-Tower Console** | Admin SPA (separate repo). The operational admin surface for user/role/store/device lifecycle; consumes Data-Pulse OpenAPI contracts only. |
| **External identity provider** | Currently Clerk; the authority for password, MFA, email verification, and identity-token issuance. Must be replaceable (Auth0 / Keycloak / OIDC). |
| **Support / admin operator** | Retail Tower support staff performing remediation (e.g. device revoke for a lost terminal); actions are audited. |

---

## 5. Authority model

| Concern | Authority | Notes / evidence |
|---|---|---|
| Password, MFA, email verification, identity-token issuance | **External identity provider** | Clerk in v1; verified at the DP-2 edge via JWKS — `apps/api/src/pos-operators/clerk-verifier.ts`. Retail Tower never stores/verifies cloud passwords (FR-POS-AUTH-8/10). |
| Tenant membership, role, store access, POS eligibility | **Data-Pulse** | `memberships` / `store_access` / `roles`; eligibility check in `operator-context-resolver.ts` (`{owner, tenant_admin, store_manager}` for the manager/admin sale path). |
| Internal sessions, device binding, authorization decisions, audit | **Data-Pulse** | Opaque revocable bearer tokens; `devices` table (hashed token); audit interceptor reads `principal.userId`. |
| Operational access management (create/invite/assign/reset/disable/revoke) | **Console** (UX) over **Data-Pulse** (authority) | Console is the admin UX; managers/admins do **not** operate the provider vendor dashboard directly (G4). |
| Terminal runtime + offline unlock | **POS-Pulse** | Local PIN, cached profile, local outbox; never the cloud-password surface. |
| Cashier identity | **NOT ERPNext** | ERPNext is valuation/back-office only; it is never in the POS auth path (NG2/NG3). |

**Separation restated:** authentication (who the human is) is the provider's job;
authorization (what the human may do, on which tenant/store, with which role) is
Data-Pulse's job. The new identity link/adapter (§13) is the **only** seam where
provider identity crosses into Data-Pulse authorization, and it must be
provider-neutral at the domain boundary.

---

## 6. Credential matrix

> **Reading note.** "Authorizes today" reflects the **shipped runtime** (evidence
> cited); "Authorizes (target)" reflects this spec's intended end state. Where
> they differ, the row is a **documented drift** for later correction (§15).

| Credential | Issuer | Stored by | Valid at | Authorizes (target) | Must NEVER authorize | Expiry / revocation | Logging / secrecy |
|---|---|---|---|---|---|---|---|
| **External provider JWT/session** (Clerk JWT today) | Identity provider | POS-Pulse client (in memory / provider SDK) | DP-2 edge for **identity proof at sign-in** | Identity proof at operator sign-in only | Sale ownership; sale-sync as the durable credential; any backend write authority on its own | Provider-controlled expiry; DP-2 does not revoke the provider session | Verified at edge, **never** logged/persisted/enqueued/returned (FR-POS-AUTH-10; `clerk-verifier.ts`, `operator-context-resolver.ts`) |
| **Device pairing token** (`device_token`) | DP-2 (issued at pairing; CONSUME shipped in `027`) | POS-Pulse OS secret storage; DP-2 stores only `token_hash` | DP-2 device-scoped routes | Terminal/device-scoped ops: catalog **read-down**; **sign-in attestation** | Sale ownership; operator identity; cloud admin | Revocable via `devices.revoked_at`; rotation on re-pair | Returned **once** at pairing; only `token_hash` persisted; never logged (027 FR-006; `pos-device-auth.guard.ts`) |
| **Internal `pos_operator` token** | DP-2 (at sign-in) | DP-2 (`auth_tokens`, hashed); POS client (if issued) | DP-2 POS-operator routes | POS operator-scoped ops — **target credential for sale-sync** | Dashboard/admin routes (scope-gated out); read-down does not require it | Opaque, revocable; bounded session expiry (§9) | Token value never logged; only hashes persisted |
| **Console / dashboard session** | DP-2 | httpOnly cookie (browser); DP-2 `sessions` | DP-2 dashboard / admin routes | Human admin operations (user/role/store/device lifecycle) | POS routes (rejected by POS scope guards); machine/connector routes | Cookie + server session expiry; revocable | httpOnly; argon2id; not exposed to JS; never in logs |
| **Connector bearer token** | DP-2 (018 lifecycle) | Connector app; DP-2 stores hash | DP-2 `/api/connector/v1/*` machine routes | Connector machine ops (posting feed/ack, bin-view, health) | POS routes; dashboard routes; human admin routes | Issue/rotate/revoke/disable lifecycle (018) | Raw secret shown once; never logged |
| **Local offline PIN** | POS-Pulse (set locally **after** online verification) | POS-Pulse local secret storage only | The **paired terminal only**, for **offline unlock** | Unlock a cached operator profile on its own terminal | **Any backend API** (never sent to / verified by DP-2); cloud password; another terminal | Bounded by offline grace period (§10, open question); cleared on re-pair/restore | Never transmitted to backend (FR-POS-AUTH-8); stored as a local hash; never logged |

**Required decisions (captured):**

- **CM-1** — Provider JWT is valid for **identity proof / sign-in only**, not for
  sale-sync as the durable credential.
- **CM-2** — Device token is valid for **terminal/device-scoped** operations
  (catalog read-down, sign-in attestation), **not** for sale ownership.
- **CM-3** — `pos_operator` token is valid for **POS operator-scoped**
  operations such as sale-sync (target).
- **CM-4** — Local PIN is valid **only on a paired terminal for offline unlock**,
  **never** against backend APIs.

**Drift on CM-1/CM-3 (must be stated honestly):** the shipped sale-sync guard
`PosOperatorSaleAuthGuard` (owner-ratified "Option Y", 2026-06-10) authenticates
sale routes with a **raw Clerk JWT** (`Authorization: Bearer <clerk-jwt>`) plus a
device attestation header (`X-Device-Attestation`), and synthesizes a
`pos_operator`-scoped principal *internally* rather than requiring a client-held
`pos_operator` token. Its own header comment states operator sign-in *"never
returns [a `pos_operator` token] to the client."* Therefore **today** the durable
sale-sync credential is the provider JWT, which the target model (CM-1/CM-3,
NG7) forbids. This is the central drift this feature exists to surface; the fix
is later, separately-specified work (§15). **Direction now decided (OQ-8, §
Clarifications):** Option-Y is a v1 bridge; the target is an internal,
provider-neutral operator-authorization envelope minted at sign-in (the
`pos_operator` credential the scope guard already expects) — not the raw
provider JWT.

---

## 7. Route / surface authorization matrix

> Columns: required credential, authority source, success condition, refusal
> condition. "Today" notes mark shipped behaviour vs target where they differ.

| Surface | Required credential | Authority source | Success condition | Refusal condition |
|---|---|---|---|---|
| **POS catalog read-down** (`/api/pos/v1/catalog/snapshot\|deltas`) | Device token (Bearer) | Device row `(tenant,store)` | Active, unrevoked device token → `(tenant,store)` from the device row | Missing/malformed header, unknown/revoked token, any non-device credential → generic 401 (`PosDeviceAuthGuard`) |
| **POS operator sign-in** (`POST /api/pos/v1/operators/sign-in`) | Provider JWT (identity) **+** device token (attestation) | Provider (identity) → DP-2 (membership/role/store) | Valid JWT → mapped active user → active device → eligible membership/role → store access → issue internal operator session | Any factor fails → generic refusal envelope (FR-POS-AUTH-6); no JIT provisioning (FR-POS-AUTH-3) |
| **POS sale-sync** (capture/void/refund POS sale routes) | **Target:** internal `pos_operator` token. **Today:** provider JWT (Bearer) + device attestation (`X-Device-Attestation`) | DP-2 operator authority (resolved); scope `pos_operator` | **Today:** `OperatorContextResolver` returns `ok` → context `(tenant,store,user)` from device+membership; principal scope `pos_operator` published. **Target:** client presents `pos_operator` token; scope guard admits | Any resolver refusal collapses to generic 401 (`PosOperatorSaleAuthGuard`); device-token-only must be refused (NG6) |
| **POS offline unlock** | Local PIN (on-terminal) | POS-Pulse local (cached profile) | Correct PIN within grace period on the paired terminal | Wrong/locked PIN; grace expired; first-ever login (must be online); never a backend call |
| **Console user admin** (create/invite/assign/reset/disable/revoke) | Dashboard session (cookie) | DP-2 session + RolesGuard | Authenticated human admin with sufficient role | POS/machine credentials rejected; session-only admin guard rejects bearer (018 pattern) |
| **Password reset (initiate)** | Dashboard session (cookie) initiating; provider performs reset | DP-2 (authorization) → provider adapter | Admin/self initiates; provider sends reset; DP-2 audits the initiation | Initiation without authority; any attempt to reset locally/offline (NG5) |
| **Device pairing (CONSUME)** | One-time pairing code (anonymous) | Code row tenant (bootstrapped) | Shipped in `027` — see that spec | `INVALID_CODE`/`EXPIRED_CODE`/`ALREADY_PAIRED`/`BRANCH_MISMATCH`/`RATE_LIMITED`/`validation_failure` (027) |
| **Device revocation** | Dashboard session (cookie) | DP-2 admin authority | Admin revokes → `devices.revoked_at` set; token rejected thereafter | Non-admin; cross-tenant device (non-disclosing) |
| **Connector endpoints** (`/api/connector/v1/*`) | Connector machine bearer | DP-2 connector registration (018) | Valid linked registration token | POS JWT, device token, dashboard cookie all rejected (`ConnectorAuthGuard`) |
| **ERPNext access** | n/a (POS path) | n/a | — | **POS never authenticates to ERPNext** (NG3). Only the connector talks to ERPNext, out-of-band of this matrix. |

---

## 8. User lifecycle

Normal user creation, reset, and disable flows **start in Console**; Data-Pulse
coordinates business authorization and calls the identity-provider adapter (§13).
Admins should **not** manage operational users directly in the provider's vendor
dashboard (G4).

| Step | Requirement |
|---|---|
| **Create / invite user** | Console initiates; DP-2 creates the local user + the provider identity (via adapter `createIdentity`/`inviteUser`); a provider-neutral identity link records `(provider_key, issuer, subject, user_id, email, status, linked_at)`. No shared accounts (NG8). |
| **Assign role** | Console assigns an internal role (`owner`/`tenant_admin`/`store_manager`/`store_staff`); DP-2 records membership. Authorization is decided by DP-2, never by a provider claim. |
| **Assign store access** | Console sets `store_access_kind = all\|specific` (+ the access set); DP-2 enforces it at sign-in and sale-sync (`operator-context-resolver.ts` step 5). |
| **First online login** | Must be **online** (NG/§10). Provider verifies the human; DP-2 resolves the local user by identity link, validates membership/role/store, and establishes the operator session. |
| **Password reset** | **Cloud/provider-driven**, initiated from Console/DP-2 via the adapter (`sendPasswordReset`). DP-2 stores no password and performs no local reset. |
| **Disable user** | Console initiates; DP-2 soft-deletes/disables the local user and calls adapter `disableIdentity`. Disabled users fail sign-in (`user_disabled`) and sale-sync. |
| **Remove store access** | Console removes the store from the access set; subsequent sign-in/sale-sync for that store fails (`store_not_in_access_set`). |
| **Restore user** | Console re-enables; DP-2 calls `enableIdentity` and restores membership; identity link status returns to active. |
| **Audit of admin actions** | Every create/invite/assign/reset/disable/revoke is audited with the acting admin, target, and action — never with secret values. |

---

## 9. POS operator lifecycle

| Aspect | Requirement |
|---|---|
| **Paired-terminal prerequisite** | A terminal must already hold a valid `device_token` (pairing shipped in `027`). Sign-in requires device attestation alongside identity. |
| **Online sign-in** | Provider identity (JWT) + device attestation → DP-2 resolves the local user by **provider subject / external identity link**, validates membership in the device's tenant, role eligibility, and store access. |
| **Local user resolution** | **Today:** `users.clerk_user_id = sub` (`operator-context-resolver.ts` step 2). **Target:** resolution via the provider-neutral identity link (§13), with `clerk_user_id` reclassified as a v1 legacy bridge. |
| **Membership + store validation** | Membership must exist and be unrevoked/undeleted; store eligibility per `store_access_kind`. |
| **Eligible POS roles** | The manager/admin sale path requires `{owner, tenant_admin, store_manager}` (`ELIGIBLE_INTERNAL_ROLES`); `store_staff` (cashier) eligibility for which surfaces is role-policy (see open questions). |
| **Issue internal session/token** | Sign-in issues an internal **`pos_operator`** session (002 §5.1 step 6 / FR-POS-AUTH-4). **Drift:** the shipped sale-sync path does **not** rely on a client-held `pos_operator` token (Option Y); reconciling issuance + use is §15 work. |
| **Session expiry** | The operator session is bounded; expired sessions must be refused on sale-sync (returns 401, see §16 scenario). |
| **Session renewal** | Renewal re-verifies identity + device + current authorization (membership/role/store may have changed). |
| **Sign-out** | `POST /api/pos/v1/operators/sign-out` ends the internal session (DP-2 does **not** revoke the provider session — FR-POS-AUTH; Clerk session lifecycle is the provider's). |
| **Takeover behaviour** | Whether a new sign-in on a terminal supersedes an existing operator session is an open question (§18). |
| **Same operator, multiple terminals** | Whether one operator may hold concurrent sessions on multiple terminals, or whether the latest takes over, is an open question (§18). |
| **Sale-sync when session expired** | Expired operator authority → sale-sync refused (401); pending offline sales remain queued until a valid session is re-established (§10, §16). |

---

## 10. Offline POS behaviour

| Rule | Requirement |
|---|---|
| **OFF-1** | **First login cannot be offline.** A terminal/operator must complete at least one successful online verification before any offline unlock is possible. |
| **OFF-2** | Offline unlock uses a **local PIN** + **cached operator profile**, validated entirely on the terminal. |
| **OFF-3** | Offline unlock is **not** cloud-password authentication and never contacts the backend for credential verification. |
| **OFF-4** | A local PIN can only be **set after** a successful online verification (no PIN exists before first online login). |
| **OFF-5** | Offline access must have a **bounded grace period** (exact value is an open question — §18). After expiry, the terminal must require re-online verification. |
| **OFF-6** | Offline sale capture records **operator, device, store, and local timestamps** so provenance survives to sync. |
| **OFF-7** | Offline sales remain in the **local outbox** until sync; they are immutable local facts pending upload. |
| **OFF-8** | On reconnect, the terminal **reconciles** current authorization and revocation: a disabled user, removed store access, or revoked device discovered on reconnect must block further unlock and govern how queued sales sync (§16, §18). |

**Open decisions (also in §18):** maximum offline grace period (same business day
vs 8h vs 24h vs tenant-configurable); whether a manager override is allowed
offline; whether offline-captured sales sync under the original operator only or
under a supervised manager/admin session if the original operator is
unavailable.

---

## 11. Password reset vs local PIN reset

These are **two distinct mechanisms** and must never be conflated.

| Mechanism | Requirement |
|---|---|
| **Cloud password reset** | Identity-provider-driven, **initiated through Console/Data-Pulse** (adapter `sendPasswordReset`). POS **never** stores or verifies cloud passwords (FR-POS-AUTH-8). |
| **Local PIN reset (online)** | Separate from password reset. Requires **identity re-authentication** (the human re-proves identity online) before a new PIN is set. |
| **Local PIN reset (offline, if allowed)** | If permitted at all (open question), requires a **manager override** and produces a **local audit record** that **syncs later**. |
| **No silent self-service** | A cashier **alone** may not silently reset their own PIN offline. Any offline reset requires supervised override + audit. |

---

## 12. Device lifecycle

> Device-pairing **CONSUME** is shipped in `027-pos-terminal-pairing-consume`;
> this section references it and defines the surrounding lifecycle and offline
> behaviour, it does not re-spec the CONSUME endpoint.

| Step | Requirement |
|---|---|
| **Pair terminal** | An admin issues a one-time pairing code (issuance is a separate, not-yet-contracted workstream per `027`); the terminal redeems it via `posPairTerminal` and receives a `device_token` **once**. |
| **Device token storage** | Stored in OS secret storage on the terminal; DP-2 persists only `token_hash`. |
| **Device token rotation** | Rotation occurs on re-pair (a fresh code → fresh token); the body never carries the token into idempotency/payload hashes (cf. `PosOperatorSaleAuthGuard` rationale). |
| **Device revoke** | Admin sets `devices.revoked_at`; the token is rejected on all device-scoped routes thereafter (`findActiveByAttestation` returns active rows only). |
| **Lost / stolen terminal** | Support/admin revokes the device promptly; any local PIN on that terminal becomes irrelevant because revocation is enforced on reconnect (OFF-8) and the device token no longer authenticates. |
| **Re-pair terminal** | A revoked or wiped terminal re-pairs via a new code; prior local secrets must be cleared. |
| **Device revoked while offline** | The terminal may continue offline within the grace period using the local PIN, but on reconnect the revoked device is detected and further unlock/sync is governed by the reconciliation rules (§10/§16/§18). |
| **Safe local storage** | Device token and local PIN hash live in OS secret storage; never in plaintext, logs, or a copyable flat file (§16 "DB copied to another machine"). |
| **Local secret storage unavailable** | If OS secret storage is unavailable, the terminal must **fail closed** (no offline unlock, no silent fallback to insecure storage) and require online sign-in. |

---

## 13. Provider independence / anti-lock-in

Define a provider-neutral seam: **`IdentityProviderPort`** (a.k.a.
`IdentityProviderAdapter`). All provider interaction in Data-Pulse business code
flows through this port; no provider SDK type crosses into authorization logic or
route contracts.

**Required port operations:**

- `createIdentity`
- `inviteUser`
- `verifyIdentityToken`
- `sendPasswordReset`
- `disableIdentity`
- `enableIdentity`
- `getIdentityProfile`
- `linkExternalIdentity`
- `unlinkExternalIdentity` (if needed)

**Provider-neutral identity mapping (domain shape):**

| Field | Meaning |
|---|---|
| `provider_key` | Which provider (`clerk` / `auth0` / `keycloak` / `oidc`). |
| `issuer` | The provider's `iss`. |
| `subject` | The provider's stable subject (`sub`). |
| `user_id` | The Data-Pulse local user id (the authorization anchor). |
| `email` | Contact/identity email (PII — handled per §XIV). |
| `status` | active / disabled / unlinked. |
| `linked_at` | When the external identity was linked. |

**Statements (binding for the target model):**

- **PI-1** — Clerk-specific fields and APIs must **not** leak into POS business
  authorization or route contracts. The current `clerkJwt` OpenAPI security
  scheme name and the `users.clerk_user_id` column are **v1 implementation
  details / a legacy bridge**, not the long-term domain model. Evidence of the
  current coupling: `clerk-verifier.ts` (`@clerk/backend` via `verifyToken`),
  `operator-context-resolver.ts` (`WHERE clerk_user_id = $1`).
- **PI-2** — A future migration to Auth0 / Keycloak / generic OIDC must **not**
  require rewriting POS authorization rules. Authorization keys off the local
  `user_id` + membership/role/store, never off a provider-specific claim.
- **PI-3** — `verifyIdentityToken` replaces the direct `ClerkVerifier` call at the
  trust boundary; the resolver consumes a provider-neutral verified-subject
  result, not Clerk claims.

---

## 14. Security and audit requirements

- **SEC-1** — No raw passwords anywhere in Retail Tower (NG1, FR-POS-AUTH-8).
- **SEC-2** — No token values in logs (any token: provider JWT, device, operator,
  connector, dashboard) — evidence: `clerk-verifier.ts`,
  `operator-context-resolver.ts`, `pos-device-auth.guard.ts`, `027` FR-006.
- **SEC-3** — No long-lived **raw** provider JWT storage; the JWT is verified at
  the edge and not propagated past the verifier (FR-POS-AUTH-10 / ADR D3).
- **SEC-4** — No shared cashier accounts (NG8); one human → one identity →
  one operator.
- **SEC-5** — All admin actions audited (who, what, target, when) — never with
  secrets.
- **SEC-6** — All sign-in refusals are **non-enumerating** to clients: a single
  generic 401/refusal envelope regardless of which factor failed (FR-POS-AUTH-6;
  every guard collapses to a generic `UnauthorizedException`).
- **SEC-7** — Server logs **may** record a refusal reason keyed by request id
  (the typed resolver `refused.reason`) without leaking secrets — for operator
  debuggability, not client disclosure.
- **SEC-8** — Offline actions are audited **locally** and synced later (OFF-6/§11).
- **SEC-9** — Sale facts preserve **operator / device / store** provenance
  (context scoped from the device row + membership, never from the request body —
  the FR-061 mass-assignment ban).
- **SEC-10** — Token scopes are **not** interchangeable (a `pos` device principal
  may not enter `pos_operator` routes; a dashboard cookie may not enter POS
  routes; a connector bearer may not enter human/admin routes) — enforced by the
  per-route scope guards.
- **SEC-11** — POS **never** receives provider admin credentials (NG4).

---

## 15. OpenAPI / documentation cleanup requirements

> **No OpenAPI YAML is edited in this feature.** This section enumerates the
> later, separately-gated cleanup the target model requires. Each item is a
> `[GATED]` contract change to be specified and approved on its own.

- **DOC-1** — Correctly distinguish, in the contracts and their narratives, three
  Bearer-carried credentials that currently share the `Authorization` header in
  different surfaces: **provider JWT** (sign-in identity), **device bearer**
  (read-down + attestation), and the **internal `pos_operator` bearer**
  (operator-scoped). Today the same `Authorization: Bearer` transport carries a
  device token on read-down and a Clerk JWT on sale-sync — the schemes must be
  named so they are not confusable.
- **DOC-2** — Remove or rename the misleading **Clerk-specific** security scheme
  name (`clerkJwt`) wherever a **provider-neutral** identity scheme or an
  **internal** token is actually intended (PI-1).
- **DOC-3** — Ensure the **sale-sync contract matches runtime auth**: today the
  shipped sale-sync uses a provider JWT + `X-Device-Attestation` header (Option
  Y) — the contract and the target (`pos_operator`) must be reconciled so the
  documented scheme is the one actually enforced. **Decided shape (OQ-8, §
  Clarifications):** the target scheme is the **internal `pos_operator`
  operator-authorization envelope minted at sign-in** (provider-neutral), and the
  contract is updated to that scheme — Option-Y is documented as the v1 bridge it
  supersedes, not the end state.
- **DOC-4** — Ensure the **catalog read-down** contract documents **device-token**
  auth explicitly (the device scheme — historically mislabeled `posDeviceAuth` /
  `clerkJwt` in the contracts README; the runtime scheme is a Bearer device
  token via `PosDeviceAuthGuard`).

---

## 16. Scenarios

Each scenario states the expected behaviour under the **target** model; where the
shipped runtime differs, the difference is noted.

1. **Tenant admin creates a new cashier in Console.** Console → DP-2 creates local
   user + provider identity via adapter; identity link recorded; role + store
   assigned; no shared account permitted; action audited. No provider-dashboard
   step.
2. **Cashier completes first online login on a paired terminal.** Provider JWT +
   device attestation → DP-2 resolves user (via identity link), validates
   membership/role/store → establishes operator session. A local PIN may now be
   set (OFF-4). First login succeeds only online (OFF-1).
3. **Cashier opens POS offline after prior successful online login.** Local PIN +
   cached profile unlock within the grace period; no backend call (OFF-2/3/5).
4. **Cashier tries first login while offline.** Refused — first login must be
   online (OFF-1); no PIN exists yet (OFF-4).
5. **Cashier forgets cloud password.** Provider-driven reset initiated through
   Console/DP-2 (`sendPasswordReset`); DP-2 stores no password (§11). Online only
   (NG5).
6. **Cashier forgets local PIN.** Online: identity re-auth then set a new PIN.
   Offline: only via manager override + later audit sync, if allowed at all
   (§11/§18).
7. **Manager initiates password reset.** Authorized via Console; DP-2 calls the
   adapter; initiation audited; no local password handling.
8. **Manager disables cashier while terminal is online.** DP-2 disables user +
   `disableIdentity`; the next sale-sync/sign-in fails (`user_disabled` →
   generic 401); active session refused on next authorized call.
9. **Manager disables cashier while terminal is offline.** Terminal may continue
   within the grace period; on reconnect the disabled state is detected (OFF-8)
   and further unlock is blocked; queued-sale sync follows the reconciliation
   rule (§18 open question).
10. **Store access removed while POS is offline.** Same as #9: enforced on
    reconnect; subsequent store-scoped sale-sync fails (`store_not_in_access_set`).
11. **Device revoked while offline.** Local PIN may unlock within grace, but the
    device token no longer authenticates; on reconnect revocation is enforced
    (OFF-8/§12); re-pair required to resume.
12. **Pending offline sales but operator session expired.** Sales stay in the
    local outbox; sync requires a re-established valid operator authority; an
    expired session yields 401 on sync until renewed (§9/§18 covers
    original-operator-unavailable).
13. **Network drops during sign-in.** Sign-in fails cleanly (no partial session);
    the terminal falls back to offline unlock **only** if a prior online login
    established a cached profile + PIN (OFF-1); otherwise it must retry online.
14. **Sale-sync receives 401.** The credential/authority is invalid or expired
    (revoked device, disabled user, expired session, ineligible role); the client
    must re-authenticate (online sign-in) and retry; the sale stays queued.
15. **Sale-sync receives duplicate / idempotent replay.** The existing
    Idempotency-Key interceptor + `(sourceSystem, externalId)` dedup make the
    replay return the original outcome, not a second sale. Auth credentials must
    **not** ride in the body (so a token rotation between retries does not change
    the idempotency fingerprint — `PosOperatorSaleAuthGuard` rationale).
16. **Same cashier signs in on two terminals.** Behaviour (concurrent sessions vs
    takeover) is an open question (§18); whichever is chosen must be auditable.
17. **Identity provider temporarily down.** Sign-in fails closed (the verifier
    throws → generic refusal; reason logged server-side per SEC-7). Already-online
    cashiers continue offline within the grace period. No insecure fallback.
18. **Identity provider migrated from Clerk to another provider.** With the §13
    port + identity link in place, migration re-points `verifyIdentityToken` and
    relinks identities; **POS authorization rules do not change** (PI-2). Without
    the port (today), this would require touching the resolver and contracts —
    which is exactly the lock-in this feature targets.
19. **Local secret storage unavailable.** The terminal fails closed: no offline
    unlock, no insecure fallback; requires online sign-in (§12).
20. **Terminal clock is wrong.** Offline grace-period checks must not be trivially
    defeated by a wrong local clock; reconnect re-establishes authority against
    server time. (Clock-trust policy detail is a hardening concern for the later
    build spec.)
21. **Local POS DB copied / restored onto another machine.** A copied local store
    must not yield a usable session on a different machine: the device token is
    bound to the paired terminal and revocable; secrets live in OS secret storage
    (not a copyable flat file); on reconnect the mismatch/revocation is enforced.
22. **Admin attempts to create a shared cashier account.** Rejected by policy
    (NG8/SEC-4): one human → one identity → one operator; Console must not offer a
    shared-account path.

---

## 17. Acceptance criteria

This specification is accepted when:

- **AC-1** — It clearly separates **authentication** (provider) from
  **authorization** (Data-Pulse). (§5)
- **AC-2** — It clearly identifies **Console/Data-Pulse** as the operational
  authority (not the provider dashboard). (§5, §8)
- **AC-3** — It contains a **credential matrix** with issuer / storage / validity
  / authorizes / must-never / expiry / secrecy per credential. (§6)
- **AC-4** — It contains a **route/surface authorization matrix**. (§7)
- **AC-5** — It defines **first-login-online** behaviour. (§10 OFF-1, §16 #2/#4)
- **AC-6** — It defines **offline PIN unlock** behaviour, bounded and auditable.
  (§10, §11)
- **AC-7** — It defines **password reset** and **PIN reset** as **separate**
  mechanisms. (§11)
- **AC-8** — It defines **account and device revocation** for both **online** and
  **offline** cases. (§8, §10 OFF-8, §12, §16 #8–#11)
- **AC-9** — It defines **sale-sync credential** requirements and states the
  target (`pos_operator`) vs the shipped drift (provider JWT). (§6 CM-1/CM-3, §7,
  §9, §15 DOC-3)
- **AC-10** — It defines **provider-neutral identity adapter** concepts
  (`IdentityProviderPort` + identity mapping). (§13)
- **AC-11** — It identifies existing **docs/OpenAPI drift** to fix later without
  editing any contract here. (§15)
- **AC-12** — It does **not** implement code, migrations, OpenAPI, or runtime
  changes. (§3 NG9)
- **AC-13** — It reflects **existing runtime evidence** (cited files) honestly,
  marking shipped-but-divergent behaviour as drift rather than as a satisfied
  requirement. (§6 drift note, §9, §13 PI-1)

---

## 18. Open questions

> These are owner/product decisions; the spec records them as unresolved rather
> than guessing.

- **OQ-1** — ✅ **RESOLVED 2026-06-11** (Orchestrator 028, adopted): offline grace =
  **tenant-configurable, default 24h** within a hard platform ceiling (Console policy
  knob; default applies when unset). (§10 OFF-5, § Clarifications)
- **OQ-2** — **Manager override offline**: is an offline manager override allowed
  at all (for PIN reset, for elevated actions)? (§10, §11)
- **OQ-3** — **PIN policy**: complexity rules and retry-lockout policy for the
  local PIN. (§10/§11)
- **OQ-4** — **Multi-terminal operator sessions**: allowed concurrently, or does a
  new sign-in force a takeover? (§9, §16 #16)
- **OQ-5** — ✅ **RESOLVED 2026-06-11** (Orchestrator 028, adopted): pending offline
  sales **sync on the still-valid device trust + the sale's captured-time
  operator/device/store provenance** — no forced original-operator re-auth;
  post-revocation actions still refused; the sale fact is never rewritten.
  Manager-supervised sync is **not** required for v1. (§10, §16 #12, § Clarifications)
- **OQ-6** — ✅ **RESOLVED 2026-06-11** (Orchestrator 028, adopted): v1 **introduces the
  provider-neutral identity link first** (`provider_key`/`issuer`/`subject` → local
  `user_id`); `users.clerk_user_id` is reclassified as a **bridge column behind it**,
  not the long-term join key. (§9, §13 PI-1, § Clarifications)
- **OQ-7** — ✅ **RESOLVED 2026-06-11** (Orchestrator 028, adopted): provider migration is
  **architecture-readiness only, NOT v1 build scope** — the §13 port + identity link make
  a future switch a per-adapter change; no second provider integration is built in v1; a
  staged dual-link plan is authored only if/when a switch is scheduled. (§13, § Clarifications)
- **OQ-8** — ✅ **RESOLVED 2026-06-11** (Orchestrator 028, adopted): Option-Y (provider JWT +
  attestation) is a **v1 bridge**; the target is an **internal provider-neutral
  operator-authorization envelope minted at sign-in**, which IS the `pos_operator` credential
  the canonical scope guard expects (reconciling issuance↔use). DOC-3's documented sale-sync
  scheme becomes the internal operator scheme, not the raw provider JWT. Implementation is a
  later `[GATED]` DP-2 slice. (§6 CM-1/CM-3, §15, § Clarifications)

---

## Evidence inspected (grounding, not modified)

- `apps/api/src/auth/pos-operator-sale-auth.guard.ts` — Option-Y sale-sync auth
  (Clerk JWT + `X-Device-Attestation`), synthesizes `pos_operator` principal.
- `apps/api/src/auth/pos-device-auth.guard.ts` — read-down device-token auth
  (`scope: "pos"`, context from device row).
- `apps/api/src/auth/pos-operator-auth.guard.ts` — scope gate requiring a
  `pos_operator` token (the credential sign-in does not return to clients).
- `apps/api/src/auth/operator-context-resolver.ts` — shared trust core;
  `WHERE clerk_user_id = $1`; role/store eligibility.
- `apps/api/src/pos-operators/clerk-verifier.ts` — Clerk-specific JWKS verifier
  seam (`@data-pulse-2/auth` `verifyToken`).
- `specs/002-pos-operator-identity/spec.md` — FR-POS-AUTH-1…10 anchors;
  `clerkJwt` OpenAPI scheme; `pos_operator` token issuance at sign-in.
- `specs/027-pos-terminal-pairing-consume/` — shipped device-pairing CONSUME
  (boundary reference; not re-spec'd here).
- `specs/026-returns-reversal-contract/` — adjacent feature (boundary reference).
