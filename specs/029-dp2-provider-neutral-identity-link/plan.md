# Implementation Plan — Draft D3 DP-2 Provider-Neutral Identity Link & IdentityProviderPort

> **SHIPPED — MERGED to `main` 2026-06-12** (PR #550 `0af392e`). This artifact is the as-built record; the original SPECIFY/DRAFT framing is superseded.

**For:** Data-Pulse-2 to execute **POST-dispatch** (after owner approval + verified G10).  **Altitude:** architecture only — **no code is authored here.**  **Date:** 2026-06-11.

**Gate tags for the whole slice:** **G10** (boundary signed — blocks all D3 implementation) · **G3** (Migration Gate — the link table + backfill) · **no G2** (no contract/OpenAPI change in D3).

> Every phase below is a description of an approach the owning repo would take. This document defines no schema DDL, no TypeScript, no migration SQL — those are produced inside Data-Pulse-2 under its own review, only after dispatch.

---

## Approach summary

D3 adds a provider-neutral identity seam **behind** the existing operator-auth code without changing what is authorized. The sequencing is **schema first (additive, reversible) → port + adapter → resolver re-point → backfill → bridge-column reclassification**, each phase independently reviewable and each preserving the current fail-closed behavior. Nothing in D3 touches the operator/sale-sync credential (D1/D2), the contract (D4), POS (D6/D5), or Console (D8).

## Phase 0 — Pre-flight (gate + state)

- **[G10]** Confirm G10 is verified satisfied for this consuming spec (boundary decisions signed; producer = Orchestrator 028). D3 must not begin implementation while G10 is open.
- **[G0]** Confirm Data-Pulse-2 `origin/main` is the known clean state read this session (`6588e86` badge / `0c57fed` substantive, #544); re-read `0001_pos_operator_identity.sql`, `pos-operators.service.ts`, `clerk-verifier.ts`, `packages/auth/src/clerk-jwt.ts` before touching anything.
- Confirm the DP-2 028 slice §13/PI-1/PI-3 is still the governing boundary text and that no concurrent slice (D1/D2) has already moved the resolver.

## Phase 1 — Identity-link schema seam (additive, reversible) [G3]

- Introduce the `external_identity_links` table carrying the 028 §16 mapping (`provider_key`, `issuer`, `subject`, `user_id`, `email`, `status`, `linked_at`, `last_verified_at`, `disabled_at`).
- Apply the same RLS/`FORCE`/`updated_at`-trigger conventions the repo already uses (mirror the `devices` table pattern in mig `0001`) where tenant-scoping applies.
- Add the uniqueness guard: `(provider_key, issuer, subject)` → one `user_id`; a **partial-unique** guard enforcing **single active link per `user_id`** in v1 while leaving the table able to hold future dual-link rows (028 OQ-7).
- Ship a paired `.down.sql`; the migration must be **idempotent** (`IF NOT EXISTS`) and **reversible**, matching mig `0001`'s discipline.
- **Do not drop or alter** `users.clerk_user_id` in this phase (kept for backfill + rollback).
- **Gate:** G3 — the migration is the schema-change surface; it must be reviewed safe/idempotent/reversible. No G2 (no contract).

## Phase 2 — `IdentityProviderPort` + Clerk adapter

- Define `IdentityProviderPort` with the 028 §16 operation set; the **only v1 implementation is a Clerk adapter**.
- The Clerk adapter's `verifyIdentityToken` delegates to the existing `packages/auth` `verifyToken` re-export (the `@clerk/backend` dependency stays contained there — E-3); it returns a **provider-neutral verified subject** `(provider_key, issuer, subject)`, not Clerk-typed claims.
- `linkExternalIdentity` writes/updates an `external_identity_links` row.
- Define (but do not necessarily wire live) the remaining seams — `createIdentity`, `inviteUser`, `getIdentityProfile`, `disableIdentity`, `enableIdentity`, `sendPasswordReset` — so the downstream Console/user-admin and D8 specs consume a ready port. `unlinkExternalIdentity`/`validateWebhook`/`rotateProviderCredential` only if a concrete need surfaces.
- Preserve the production fail-closed factory behavior (no allow-list shortcut; `CLERK_SECRET_KEY` required in production) behind the adapter.

## Phase 3 — Resolver re-point (PI-3)

- Replace the direct `ClerkVerifier.verify` call at the trust boundary with `IdentityProviderPort.verifyIdentityToken` (DP-2 028 slice PI-3).
- Replace `findUserByClerkSubject(sub)` (`WHERE clerk_user_id = $1`) with a resolution that joins `external_identity_links` on the provider-neutral verified subject to obtain `user_id`.
- Leave **all** downstream membership / store-access / POS-eligibility logic and the operator/sale-sync credential path **unchanged** — D3 changes only the first hop (identity → `user_id`).
- Maintain the existing fail-closed semantics: a verified token whose subject has no active link refuses, with the same non-enumerating 401/refusal envelope.

## Phase 4 — Backfill [G3]

- One-time backfill: for every user with a non-null `clerk_user_id`, create an active `clerk`-provider link (`provider_key='clerk'`, `issuer`=configured Clerk issuer, `subject`=`clerk_user_id`).
- **Fail-closed + surfaced:** any `clerk_user_id` that cannot be mapped is reported for operator reconciliation, never silently dropped (mig `0001` ADR D4 stance preserved).
- Idempotent re-run safe (no duplicate links); reversible.

## Phase 5 — Reclassify `clerk_user_id` as a v1 bridge column

- After the resolver reads only the link (Phase 3) and backfill is complete (Phase 4), document `users.clerk_user_id` as a **legacy/bridge** column: retained, off the join path, **not dropped** in v1 (rollback + audit correlation).
- Its partial UNIQUE index and format CHECK stay (backfill integrity).

## Test strategy (descriptive — tests authored in DP-2, not here)

- **Unit:** the Clerk adapter's `verifyIdentityToken` returns a provider-neutral subject and the resolver joins the link; substitute a deterministic fake adapter (the existing `CLERK_VERIFIER` DI-override pattern carries over to the port).
- **Migration:** apply/rollback idempotency for the link table; backfill correctness (mapped → link; unmapped → surfaced, not dropped); re-run safety.
- **Integration (RLS-aware):** operator sign-in/sign-out/refresh/lookup resolve via the link with the same membership/store/eligibility outcomes as today; fail-closed on an unlinked verified subject; reads on the correct pool (mirror the existing sale-auth integration RLS handling).
- **Regression:** no behavior change to the operator/sale-sync credential or any route contract (proves N-2/N-3 held).
- **Provider-readiness:** a second (stub) adapter can be registered behind the port without touching the resolver or any business rule (proves G-5 / 028 OQ-7), without integrating a real second provider.

## Out of plan (sibling slices — do not implement here)

- **D1/D2** mint+return the `pos_operator` envelope and re-wire sale-sync — keystone, separate slice.
- **D4** `clerkJwt`→role-named contract rename — additive, co-travels with D1, not D3.
- **D6** POS offline-PIN re-anchor — POS spec; also needs D1/D5 to carry `user_id` to the terminal.
- **D8** Console provider-auth login — Console spec; also needs the pre-008 client re-pin off `62d0906`.

---

> **Docs-only planning record.** No code, schema, contract, or migration is authored by this plan. Dispatch to Data-Pulse-2 requires explicit, scoped owner approval after G10 is verified satisfied. Phase order (schema → port → resolver → backfill → reclassify) is the recommended approach, not an executed change.
