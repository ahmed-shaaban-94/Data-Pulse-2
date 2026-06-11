# Tasks — Draft D3 DP-2 Provider-Neutral Identity Link & IdentityProviderPort

> **DRAFT — NOT DISPATCHED.** Planning artifact under docs-only Orchestrator. No implementation, no contract, no migration, no gate mutation. Requires explicit scoped owner approval + G10 verification before any sibling-repo dispatch.

**For:** Data-Pulse-2 to execute **POST-dispatch**.  **Date:** 2026-06-11.  **No code, SQL, or contract is authored here** — this is an ordered task list at planning altitude that the owning repo would carry out under its own review after dispatch.

**Gate legend:** **G10** = Identity & Access Boundary (blocks all D3 work until the boundary is verified signed) · **G3** = Migration Gate (schema-touching tasks) · **no G2** (D3 introduces no contract/OpenAPI change).

---

| # | Task | Gates | Depends on | Notes |
|---|---|---|---|---|
| **T0** | **Gate + state pre-flight.** Verify G10 satisfied for this consuming spec; verify DP-2 `origin/main` clean at the read HEAD (`0c57fed` / `6588e86`); re-read `0001` migration, `pos-operators.service.ts`, `clerk-verifier.ts`, `packages/auth/src/clerk-jwt.ts`, and the DP-2 028 slice §13/PI-3. | G10 | — | Hard stop if G10 is open or state drifted from the evidence basis. |
| **T1** | **Author the `external_identity_links` migration** (additive, idempotent, reversible) carrying the 028 §16 mapping fields; apply the `devices`-style RLS/`FORCE`/`updated_at` conventions where tenant-scoping applies; add a paired `.down.sql`. **Do not touch `users.clerk_user_id`.** | G3, G10 | T0 | The schema-change surface — must be reviewed safe/idempotent/reversible. |
| **T2** | **Add the uniqueness + single-active-link guard.** `(provider_key, issuer, subject) → user_id`; partial-unique enforcing one **active** link per `user_id` in v1, table shape permitting future dual-link rows. | G3, G10 | T1 | Realizes the D3-LOCAL clarification (028 OQ-7). |
| **T3** | **Define `IdentityProviderPort`** with the 028 §16 operation set. | G10 | T0 | Seam definition only; operations wired per T4/T5. |
| **T4** | **Implement the Clerk adapter** — `verifyIdentityToken` delegating to the contained `packages/auth` `verifyToken` (E-3), returning a provider-neutral verified subject; `linkExternalIdentity` writing a link row. Preserve the production fail-closed factory behavior. | G10 | T3 | The only v1 adapter (N-6). `@clerk/backend` stays package-contained behind it. |
| **T5** | **Define remaining port seams** — `createIdentity`, `inviteUser`, `getIdentityProfile`, `disableIdentity`, `enableIdentity`, `sendPasswordReset` (and conditional `unlinkExternalIdentity`/`validateWebhook`/`rotateProviderCredential`). Not all wired live in D3; defined so D8 / DP-2 user-admin consume a ready port. | G10 | T3 | Downstream consumers (D8, user-admin) depend on these existing. |
| **T6** | **Re-point the resolver (PI-3).** Replace the direct `ClerkVerifier.verify` trust-boundary call with `IdentityProviderPort.verifyIdentityToken`; replace `findUserByClerkSubject` (`WHERE clerk_user_id = $1`) with a join on `external_identity_links`. Leave membership/store/eligibility and the operator/sale-sync credential unchanged. | G10 | T2, T4 | Changes only the identity→`user_id` first hop (N-2). Preserve fail-closed non-enumerating refusal. |
| **T7** | **Backfill links from existing `clerk_user_id`.** Active `clerk` link per mapped user; unmappable subjects surfaced (fail-closed), never dropped; idempotent + reversible. | G3, G10 | T1, T2 | Preserves mig `0001` ADR D4 "fail closed when a verified JWT has no local mapping." |
| **T8** | **Reclassify `users.clerk_user_id` as a v1 bridge column.** Document legacy; off the join path; **not dropped**; keep its partial UNIQUE index + format CHECK. | G10 | T6, T7 | N-7 — demote, do not drop. |
| **T9** | **Test pass** — unit (adapter returns neutral subject; resolver joins link; DI-override fake), migration (apply/rollback/idempotency; backfill mapped→link, unmapped→surfaced), integration (RLS-aware sign-in/out/refresh/lookup parity; fail-closed on unlinked subject), regression (no envelope/contract change), provider-readiness (stub 2nd adapter behind the port, no business-rule change). | G10 | T6, T7, T8 | Proves A-1…A-10; proves G-5 readiness without integrating a real 2nd provider. |
| **T10** | **Slice verification + return to Orchestrator.** Confirm: link resolves operators; `clerk_user_id` off the join; no contract/POS/Console change; fail-closed preserved. Return to the Orchestrator for gate verification before any downstream slice (D8/D6) is dispatched. | G10 | T9 | Per CLAUDE.md: return to the orchestrator for gate verification before continuing cross-repo. |

## Dependency notes

- **Upstream:** D3 has **no upstream drift dependency** — it is the DAG foundation. Its only blocking gate is **G10** (boundary signed). Startable first once G10 is verified.
- **Downstream (recorded, not executed here):**
  - **D3 → D8** (Console provider-auth login) — the authn switch keys off D3's link + `verifyIdentityToken`. D8 *additionally* needs the Console pre-008 DP-2 client re-pin off `62d0906` (independent of D3).
  - **D3 → D6** (POS offline-PIN re-anchor) — needs D3's neutral identifier **and** D1/D5 to deliver `user_id` to the terminal (verified NEW EDGE from adversarial review). D3 alone does not satisfy D6.
- **Not gated on D3 (scope boundary):** D1/D2 (envelope keystone), D4 (contract rename — additive, refuted off D1), D9/D10 (Connector side-branch on shipped 018), D11 (board regen — independent leaf).
- **Internal ordering:** schema (T1/T2) and port (T3/T4/T5) can proceed in parallel; the resolver re-point (T6) needs both; backfill (T7) needs the schema; reclassification (T8) needs resolver + backfill complete.

---

> **No code authored here.** This task list is a planning artifact. Each task is executed inside Data-Pulse-2 under that repo's review only after explicit, scoped owner approval and verified G10. No migration SQL, TypeScript, or contract is produced by this document; the Orchestrator remains docs-only.
