# Draft D3 — DP-2 Provider-Neutral Identity Link & IdentityProviderPort

> **DRAFT — NOT DISPATCHED.** Planning artifact under docs-only Orchestrator. No implementation, no contract, no migration, no gate mutation. Requires explicit scoped owner approval + G10 verification before any sibling-repo dispatch.

**Status:** SPECIFY-ONLY / DRAFT — for owner review.  **Date:** 2026-06-11.  **Owning repo:** Data-Pulse-2 (would dispatch there post-approval).  **Deciders:** Owner (Ahmed Shaaban).

**Gate posture:** **gated — requires owner approval + G10 verification before any dispatch.** This spec touches identity/authorization resolution, so it lists **G10** (Identity & Access Boundary Gate) among its gates; the schema seam additionally carries **G3** (Migration Gate). It carries **no G2** — D3 introduces no OpenAPI/contract surface change (the sale-sync wire stays a provider JWT; the `clerkJwt`→role-named rename is sibling drift **D4**).

**Relation to 028:** Realizes 028 §16 (provider independence / anti-lock-in) and the §5 "Human identity" row's "Evidence required" cell ("Provider-neutral identity link (§16) defined + DP-2 verifies provider tokens"). 028 (and its DP-2 backend slice `specs/028-pos-auth-boundary-and-operator-lifecycle/` §13) **own** the boundary this draft conforms to; this draft is the downstream D3 implementation spec that **consumes** G10, not a re-specification of the boundary.

---

> ### authoring & placement notes (owner can redirect)
>
> - **Docs-only.** Authored under the Orchestrator's allowed `docs/**` surface, in the drafts staging area `docs/specs/drafts/028-followups/`. It implements nothing; it plans the D3 slice the owning repo (Data-Pulse-2) would execute post-dispatch.
> - **No `.specify/` tooling exists in the Orchestrator**, so this was authored manually following the speckit structure (sections, success-criteria discipline, `[NEEDS CLARIFICATION]` resolution) and the house style of `docs/specs/028-…/spec.md`. No branch, `feature.json`, or template copy was created.
> - **This feeds a future Queue Item under G10, not a kernel mutation.** Nothing here advances or mutates `docs/kernel/graph.yml` or `docs/status/kernel-state.md`. D3 becomes a Data-Pulse-2 spec/Queue Item only with explicit, scoped owner approval after G10 is verified satisfied.
> - **Boundary is mirrored, not re-derived.** The port name, its operations, and the identity-link mapping fields come verbatim from 028 §16 and the DP-2 028 slice §13/PI-1/PI-3. This draft is the granular D3 design under that signed boundary.

---

## Clarifications

### Session 2026-06-11

- Q: OQ-6 — When does the provider-neutral identity link land, and does `users.clerk_user_id` stay the durable join key? → A: **Neutral link in v1; `clerk_user_id` reclassified as a bridge column behind it** — 028 §16 + DP-2 028 slice §13 resolve OQ-6 this way; the v1 link `(provider_key, issuer, subject) → user_id` becomes the durable join key and `clerk_user_id` (mig `0001`) is demoted to a v1 bridge/legacy column, not the long-term join.
- Q: OQ-7 — Is an actual provider migration (Clerk → Auth0/Keycloak/OIDC) in v1 build scope? → A: **Architecture-readiness only, NOT v1 build** — D3 builds the link + `IdentityProviderPort` so a future switch is a per-adapter change; no second provider integration is built in v1. A staged dual-link plan is authored only if/when a switch is actually scheduled (028 OQ-7).
- Q: D3-LOCAL — In v1, may a single DP-2 `user_id` hold more than one active identity link simultaneously (e.g., during a future provider cut-over)? → A: **Single active link per user in v1; schema permits multiple rows for future dual-link** — derived from OQ-7: v1 ships one active link per user (a partial-unique guard on the active link), but the table shape `(provider_key, issuer, subject)` already supports multiple rows so a *scheduled* dual-link migration needs no reshape, only a policy relaxation. Not a boundary decision — a D3-local schema-readiness choice consistent with 028 §16.
- Q: D3-VERIFY — Does the trust-boundary token verification become provider-neutral in this slice, or only the resolution join? → A: **Both, via `verifyIdentityToken`** — DP-2 028 slice PI-3 requires `verifyIdentityToken` to replace the direct `ClerkVerifier` call at the trust boundary and the resolver to consume a provider-neutral verified subject. D3 introduces the port operation and re-points the resolver to it; the concrete Clerk implementation stays behind the adapter (the `@clerk/backend` dependency remains contained in `packages/auth`, E-3).
- Q: D3-RESOLVE — Does D3 change the operator/sale-sync *credential* (the Option-Y envelope)? → A: **No — out of D3 scope** — credential reconciliation (mint+return the `pos_operator` envelope) is D1/D2, the keystone slice; D3 only re-anchors *who the human is* (identity resolution), leaving *what is authorized* (the envelope) to the D1/D2 follow-up. Stated as N-2/N-5 below to prevent scope creep.

---

## Evidence basis (verified this session, `origin/main`, 2026-06-11)

| Repo | `origin/main` HEAD | What was read |
|---|---|---|
| Data-Pulse-2 | `6588e86` (badge) / `0c57fed` (substantive, #544) | `packages/db/drizzle/0001_pos_operator_identity.sql` (the `clerk_user_id` column + partial UNIQUE index); `apps/api/src/pos-operators/clerk-verifier.ts` (verifier seam); `packages/auth/src/clerk-jwt.ts` (the `verifyToken` re-export); `apps/api/src/pos-operators/pos-operators.service.ts` (`findUserByClerkSubject` resolution); `specs/028-pos-auth-boundary-and-operator-lifecycle/spec.md` §13/PI-1/PI-3 (the boundary input) |
| POS-Pulse | `0bb2ed8` (badge) / `b34932b` (substantive, #379) | Read-only context: POS holds no identity-link concept; consumes DP-2 sign-in. Not modified by D3 (D6/D5 are the POS follow-ups). |
| Retail-Tower-Console | `97a7d42` (#33) | Read-only context: Console authn switch is **D8**, gated downstream of D3. Not modified by D3. |
| Retail-Tower-ERP-Next-Connector | `bc768ad` (#27) | Read-only context: out of the identity path (service-to-service only). Not modified by D3. |
| Retail-Tower-Orchestrator | `main` (this repo, clean) | `docs/specs/028-…/spec.md` §5/§16; `docs/roadmap/auth-028-drift-map.md` (D3 row + DAG); `docs/gates/cross-repo-gates.md` (G10/G3/G2 definitions) — for house style and gate posture only; not modified. |

Current-runtime drift facts (kept distinct from *target* and *open decisions*):

- **E-1 (provider-coupled durable join key).** `packages/db/drizzle/0001_pos_operator_identity.sql` adds `users.clerk_user_id TEXT` (nullable), a format CHECK (`clerk_user_id IS NULL OR clerk_user_id <> ''`), and a **partial UNIQUE index** `users_clerk_user_id_uidx ON users (clerk_user_id) WHERE clerk_user_id IS NOT NULL`. The Clerk subject is the durable operator-identity join key today — there is no provider-neutral identity-link table on `origin/main`.
- **E-2 (resolution joins on `clerk_user_id`).** `apps/api/src/pos-operators/pos-operators.service.ts` resolves the local user with `findUserByClerkSubject(sub)` → `SELECT id, email, display_name, clerk_user_id, deleted_at FROM users WHERE clerk_user_id = $1 LIMIT 1`. Every operator-context path (sign-in, sign-out, refresh, lookup — service lines ~325/410/448/586/692) verifies a Clerk JWT, takes `claims.sub`, then calls this resolver. The service header comment states the contract literally: "Resolve the local user by `users.clerk_user_id = sub`."
- **E-3 (provider verification coupled, but already package-contained).** `apps/api/src/pos-operators/clerk-verifier.ts` is a `ClerkVerifier` seam whose production impl (`ClerkBackendVerifier`) calls `verifyToken(rawJwt, { secretKey, audience?, authorizedParties? })` and returns `{ sub }`. That `verifyToken` is **re-exported by `packages/auth/src/clerk-jwt.ts`** (`export { verifyToken } from "@clerk/backend"`), whose own header states it "keeps the `@clerk/backend` dependency contained" so apps "import only from here." So provider verification is Clerk-concrete but already isolated to one package — D3 lifts that isolation up one level into a provider-neutral `IdentityProviderPort.verifyIdentityToken`. There is **no** `IdentityProviderPort`/adapter and **no** provider-neutral mapping on `origin/main` today (drift-map: "`IdentityProviderPort` not yet present").

---

## 1. Summary

Data-Pulse-2 today welds operator identity to one provider: a verified Clerk JWT's `sub` is the durable join key into `users.clerk_user_id` (E-1, E-2), and verification is a Clerk-concrete `verifyToken` call behind a thin seam (E-3). 028 §16 ratified that this coupling is a **v1 bridge**, not the long-term design, and that a **provider-neutral identity link** plus an **`IdentityProviderPort`/Adapter** must land **in v1** so a future provider switch is a per-adapter change rather than a rewrite of POS/Console/sale-sync business rules.

This draft specifies **D3 — the foundation slice**: a DP-2-owned identity link mapping `(provider_key, issuer, subject) → user_id` (plus `email`, `status`, `linked_at`, `last_verified_at`, `disabled_at`), the `IdentityProviderPort` seam with the 028 §16 operation set, and the re-pointing of operator resolution from `WHERE clerk_user_id = $1` to a join on the neutral link via a provider-neutral verified subject. `clerk_user_id` is **reclassified as a v1 bridge column behind the link** — kept for backfill and rollback safety, no longer the join key.

D3 is the seam **D6** (POS offline-PIN re-anchor) and **D8** (Console provider-auth login) key off (drift-map DAG). It deliberately does **not** touch the operator/sale-sync credential (the Option-Y envelope, D1/D2), the contract/`clerkJwt` rename (D4), or any POS/Console code. It records current runtime as drift (E-1/E-2/E-3) and the target as the link+port — kept as three separate things, per 028 discipline.

## 2. Goals (G-n)

- **G-1.** Introduce a DP-2-owned **provider-neutral identity link** mapping `(provider_key, issuer, subject) → user_id` with the 028 §16 attributes (`email`, `status`, `linked_at`, `last_verified_at`, `disabled_at`).
- **G-2.** Define an **`IdentityProviderPort`/Adapter** seam exposing the 028 §16 operation set — `createIdentity`, `inviteUser`, `verifyIdentityToken`, `sendPasswordReset`, `disableIdentity`, `enableIdentity`, `getIdentityProfile`, `linkExternalIdentity` (and `unlinkExternalIdentity` / `validateWebhook` / `rotateProviderCredential` if needed) — with a **Clerk adapter** as the only v1 implementation behind it.
- **G-3.** Re-point **operator resolution** from `WHERE clerk_user_id = $1` to a join on the identity link, consuming a **provider-neutral verified subject** from `verifyIdentityToken` (DP-2 028 slice PI-3), so no business path reads `clerk_user_id` as the join key.
- **G-4.** **Reclassify `users.clerk_user_id` as a v1 bridge column** behind the link — retained for backfill correlation and rollback, removed from the resolution join, documented as a legacy/bridge column (E-1).
- **G-5.** Make a future provider switch (Auth0/Keycloak/OIDC) a **per-adapter change** — no rewrite of POS/Console/sale-sync business rules — without building a second provider integration in v1 (028 OQ-7).
- **G-6.** Backfill the link from existing `clerk_user_id` values **safely and idempotently**, fail-closed for any user whose Clerk subject is set but unmappable, preserving the current "fail closed when a verified JWT has no local mapping" behavior (ADR 0001 D4 in mig `0001`).

## 3. Non-goals (N-n)

- **N-1.** No code, migration, OpenAPI/YAML, package, lockfile, CI, generated file, runtime config, secret, env, or deployment change in this task — this is a DRAFT under the docs-only Orchestrator.
- **N-2.** **No change to the operator/sale-sync credential** (the Option-Y provider-JWT + `X-Device-Attestation` envelope, nor minting/returning a `pos_operator` envelope). That is **D1/D2**, the keystone slice; D3 re-anchors *identity*, not *authorization*.
- **N-3.** **No OpenAPI/contract change** and **no `clerkJwt`→role-named scheme rename** — that is sibling drift **D4** (additive, refuted off D1 in the DAG). D3's wire shape is unchanged (still a provider JWT presented at sign-in).
- **N-4.** **No POS-Pulse change** — the offline-PIN re-anchor off the neutral identifier is **D6** (a downstream POS spec that also needs D1/D5 to carry `user_id` to the terminal).
- **N-5.** **No Retail-Tower-Console change** — the provider-auth login switch is **D8** (a downstream Console spec that also needs the Console pre-008 client re-pin off `62d0906`).
- **N-6.** **No second provider integrated** in v1 — only the Clerk adapter is built; the port + link are readiness for a future switch (028 OQ-7).
- **N-7.** **No removal/drop of `users.clerk_user_id`** in v1 — it is demoted to a bridge column, not dropped (rollback and backfill safety).
- **N-8.** No gate mutation; no kernel-state or `graph.yml` edit; no status update; no edit to any existing Orchestrator file.

## 4. Boundary inputs consumed (not re-specified)

| Input | Source (read-only, `origin/main`) | What D3 consumes |
|---|---|---|
| Provider-independence boundary | Orchestrator 028 §16; §5 "Human identity" row | The port operation set, the mapping fields, the "neutral link in v1 / `clerk_user_id` as bridge" decision (OQ-6), the "migration = readiness-only" decision (OQ-7). |
| DP-2 implementation boundary | DP-2 `specs/028-pos-auth-boundary-and-operator-lifecycle/spec.md` §13, PI-1, PI-3 | `IdentityProviderPort` name + operations; `verifyIdentityToken` replaces the direct `ClerkVerifier` call at the trust boundary; the resolver consumes a provider-neutral verified subject; "today: `users.clerk_user_id = sub`; target: resolution via the link." |
| Gate that governs dispatch | Orchestrator `docs/gates/cross-repo-gates.md` G10 (+G3) | G10 must be verified satisfied before D3 dispatches; the schema seam carries G3; no G2 (no contract change). |

## 5. Identity-link schema seam (target — described at spec altitude, NOT code)

A new DP-2-owned table (working name `external_identity_links`), tenant-isolated under the same RLS pattern as `devices`/`memberships` if/where tenant-scoping applies, carrying the 028 §16 mapping:

| Attribute | Role | Source |
|---|---|---|
| `provider_key` | Which provider — `clerk` in v1; the discriminator a future adapter selects on. | 028 §16; DP-2 §13. |
| `issuer` | The provider's `iss` claim. | 028 §16. |
| `subject` | The provider's stable subject (`sub`) — the value `clerk_user_id` holds today. | 028 §16; E-2. |
| `user_id` | FK → `users(id)`; the local user the external identity resolves to. | 028 §16. |
| `email` | Provider-asserted email at link time (informational; DP-2 owns membership, not email truth). | 028 §16. |
| `status` | Link status (active / disabled), driving `disableIdentity`/`enableIdentity`. | 028 §16. |
| `linked_at` | When the link was established. | 028 §16. |
| `last_verified_at` | Last successful `verifyIdentityToken` for this link. | 028 §16. |
| `disabled_at` | When the link was disabled (nullable). | 028 §16. |

Seam properties (plan-phase detail belongs in `plan.md`/`tasks.md`, not here):

- **Uniqueness.** A `(provider_key, issuer, subject)` tuple resolves to exactly one `user_id`. **Single active link per `user_id` in v1** (D3-LOCAL clarification) via a partial-unique guard on the active link; the table shape permits multiple rows so a future *scheduled* dual-link migration needs no reshape (028 OQ-7).
- **`clerk_user_id` reclassification.** Retained as a **v1 bridge column** (E-1), documented as legacy, no longer the resolution join key (G-4). Its partial UNIQUE index and format CHECK stay for backfill integrity and rollback; removal is explicitly out of v1 scope (N-7).
- **Migration safety (G3).** The link table create + backfill from existing non-null `clerk_user_id` (provider_key=`clerk`, issuer=the configured Clerk issuer, subject=`clerk_user_id`) must be idempotent, reversible (a `.down.sql`), and fail-closed: a user with a non-null `clerk_user_id` that cannot be mapped is surfaced, never silently dropped — preserving mig `0001`'s "fail closed when a verified JWT has no local mapping" stance.

## 6. `IdentityProviderPort` seam (target)

A provider-neutral port (DP-2 028 slice §13 names it `IdentityProviderPort`) with the 028 §16 operations. D3 introduces the port and the **single v1 Clerk adapter**; only the operations D3's resolution path needs are *wired live* in this slice, the rest are defined seams the later lifecycle specs (Console D8 / DP-2 user-admin) consume.

| Operation | D3 role | Notes |
|---|---|---|
| `verifyIdentityToken` | **Wired live in D3.** Replaces the direct `ClerkVerifier`/`verifyToken` call at the trust boundary (PI-3); returns a provider-neutral verified subject `(provider_key, issuer, subject)` the resolver joins on. | The Clerk adapter delegates to the existing `packages/auth` `verifyToken` (E-3) — the `@clerk/backend` dependency stays package-contained behind the adapter. |
| `linkExternalIdentity` | **Wired live in D3.** Records/updates an `external_identity_links` row joining an external identity to a `user_id`. | Used by backfill and by the Console-initiated create/invite flow later (D8/user-admin). |
| `getIdentityProfile` | Seam defined; used by lifecycle flows. | Read-only profile fetch. |
| `createIdentity`, `inviteUser` | Seam defined; consumed by Console user-admin (downstream). | Not exercised by D3's resolution path. |
| `disableIdentity`, `enableIdentity` | Seam defined; drive link `status`/`disabled_at`. | Consumed by user disable/restore (downstream). |
| `sendPasswordReset` | Seam defined (028 §5 password-reset row). | Provider-driven; consumed by Console/DP-2 reset initiation (downstream). |
| `unlinkExternalIdentity`, `validateWebhook`, `rotateProviderCredential` | Defined only if needed; out of D3's minimal wiring. | 028 §16 marks these conditional. |

**Port rules (target):** provider-specific fields/types must not leak past the adapter; callers see only the provider-neutral verified subject and the link. The `provider_key` discriminator lives in the link row and the adapter selection, never in a business rule.

## 7. Resolution re-anchor (target)

- **Today (E-2):** verify Clerk JWT → `claims.sub` → `findUserByClerkSubject(sub)` → `WHERE clerk_user_id = $1`.
- **Target (D3):** `IdentityProviderPort.verifyIdentityToken(rawToken)` → provider-neutral verified subject `(provider_key, issuer, subject)` → resolve `user_id` via a join on `external_identity_links` → continue to the existing membership/store/eligibility checks unchanged.
- The resolver's downstream callers (sign-in, sign-out, refresh, lookup — E-2) change only their *first hop* (identity resolution); the membership/store/POS-eligibility logic and the operator/sale-sync credential are **untouched** (N-2). This isolates D3 to "who the human is."

## 8. Lifecycle touchpoints (target, D3-scoped only)

- **Backfill (one-time, G3).** Every existing user with a non-null `clerk_user_id` gets an active `clerk`-provider link; unmappable rows fail closed and are surfaced for operator reconciliation, never silently dropped.
- **New link at user create/invite (downstream wiring).** When Console-initiated user creation lands (D8/user-admin), `linkExternalIdentity` records the link; D3 defines the operation and table, the create flow consumes it later.
- **Disable/restore (downstream wiring).** `disableIdentity`/`enableIdentity` flip link `status`/`disabled_at`; D3 defines the seam, the lifecycle spec consumes it.
- **No PIN, no envelope, no device change** — those are D6/D1-D2/device-lifecycle, explicitly out of D3 (N-2/N-4).

## Acceptance criteria (A-n)

- **A-1.** A DP-2-owned identity-link concept exists mapping `(provider_key, issuer, subject) → user_id` with all 028 §16 attributes. *(§5.)*
- **A-2.** An `IdentityProviderPort` is defined with the 028 §16 operation set, and a single Clerk adapter is its only v1 implementation. *(§6.)*
- **A-3.** Operator resolution joins on the identity link via a provider-neutral verified subject; no business path uses `clerk_user_id` as the join key. *(§7; G-3.)*
- **A-4.** `verifyIdentityToken` replaces the direct `ClerkVerifier`/`verifyToken` call at the trust boundary (PI-3); the `@clerk/backend` dependency stays contained behind the adapter. *(§6; E-3.)*
- **A-5.** `users.clerk_user_id` is reclassified as a v1 bridge column — retained, documented legacy, off the join path, not dropped. *(§5; G-4; N-7.)*
- **A-6.** Backfill is idempotent, reversible, and fail-closed for unmappable subjects. *(§5; §8; G-6; G3.)*
- **A-7.** A single active link per user in v1; the schema permits future multi-row dual-link without reshape. *(§5; D3-LOCAL clarification; 028 OQ-7.)*
- **A-8.** No contract/OpenAPI change, no `clerkJwt` rename, no operator/sale-sync credential change, no POS/Console change. *(N-2/N-3/N-4/N-5.)*
- **A-9.** A future provider switch is a per-adapter change requiring no rewrite of POS/Console/sale-sync business rules; no second provider is integrated in v1. *(G-5; N-6; 028 OQ-7.)*
- **A-10.** No implementation, migration, contract, or gate mutation was performed by this draft. *(N-1; N-8.)*

## Dependencies & sequencing

D3 is the **foundation** of the auth-028 drift-map DAG (`docs/roadmap/auth-028-drift-map.md`): it has **no upstream drift dependency** and is gated only on **G10** (boundary signed) — startable first once G10 is verified.

Verified DAG edges this draft records:

- **D3 → D8** (Console provider-auth login). *Verified.* Only the Console authn switch is gated on D3 (the rest of Console user/role/store/device admin is not). Caveat carried from the DAG: D8 *also* requires the Console pre-008 DP-2 client re-pin off `62d0906` — independent of D3, but part of D8's sequencing.
- **D3 → D6** (POS offline-PIN re-anchor). *Verified + NEW EDGE from adversarial review:* D6 needs D3's neutral identifier **and** D1/D5 to deliver `user_id` to the terminal. D3 publishes the neutral identifier; the envelope (D1/D5) carries it to POS. D3 alone does not satisfy D6.

Sibling drift NOT gated on D3 (recorded to bound scope): **D1/D2** (keystone envelope — adjacent in `pos-operators.service.ts` but a separate slice), **D4** (contract rename — additive, refuted off D1), **D9/D10** (Connector side-branch — gated only on shipped 018), **D11** (board regen — independent leaf).

**Build order (drift-map):** D3 is step 1, before D1+D2, D5+D7, D6, D8.

## Open questions (OQ-n)

- **OQ-6** ✅ **RESOLVED 2026-06-11** (028 §16 + DP-2 §13): neutral link in v1; `clerk_user_id` reclassified as a bridge column behind it.
- **OQ-7** ✅ **RESOLVED 2026-06-11** (028 §16): provider migration is architecture-readiness only, not v1 build; no second provider integrated; staged dual-link plan authored only when a switch is scheduled.
- **D3-LOCAL** ✅ **RESOLVED 2026-06-11** (derived from OQ-7): single active link per user in v1; schema permits future multi-row dual-link without reshape.
- **Carried forward, NOT D3-relevant (do not auto-decide):** OQ-2 (offline manager override), OQ-3 (PIN complexity / retry-lock), OQ-4 (multi-terminal vs takeover), OQ-9 (POS local refresh-token storage), OQ-11 (break-glass for pilot). These are plan-phase/pilot-policy questions scoped to POS / Console / sale-sync follow-ups, **out of D3 scope** — D3 re-anchors identity resolution only.

---

> **Docs-only record (SPECIFY-ONLY / DRAFT).** This draft plans the D3 slice; it does not implement, define contracts, or create migrations. No implementation is dispatched from it without explicit, scoped owner approval after G10 is verified satisfied. Current runtime (E-1/E-2/E-3) is recorded as drift, not as the target.
