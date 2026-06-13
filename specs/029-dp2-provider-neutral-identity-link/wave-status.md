# Wave Status — `029-dp2-provider-neutral-identity-link`

> Human-readable summary of where the 029 D3 slice stands. 029 re-anchors
> operator identity resolution from the Clerk-welded `users.clerk_user_id = sub`
> join onto a provider-NEUTRAL `external_identity_links` table behind the
> `IdentityProviderPort` seam. It re-points ONLY "who the human is" (N-2); the
> operator/sale-sync credential and the membership/store/eligibility logic are
> unchanged.

**Last updated:** 2026-06-12 by Ahmed Shaaban — review-findings pass.
**Spec:** `029-dp2-provider-neutral-identity-link` (`specs/029-dp2-provider-neutral-identity-link/`)
**Status:** D3 implementation present in worktree (`IdentityProviderPort` + `ClerkIdentityProviderAdapter` + `0025_external_identity_links` migration + sale-sync resolver re-point). Review findings addressed below.

### Scope fences (unchanged — N-2…N-7)
- `users.clerk_user_id` is **demoted to a v1 bridge column, NOT dropped** (its partial-unique index + format CHECK survive 0025).
- **No OpenAPI / contract change**; the wire shape is still a provider JWT at sign-in.
- The **sale-sync credential** (Option Y envelope) is untouched; D3 changes only the identity-resolution first hop.

---

## Review findings — 2026-06-12

### HIGH-1 — new-user link provisioning is DEFERRED to the sign-in re-point slice (documentation resolution)

**Finding:** the `0025` backfill is a one-time snapshot of `users WHERE clerk_user_id IS NOT NULL`. `linkExternalIdentity` has no live runtime caller in D3 (only the backfill SQL + the adapter method + test seeds). Any operator onboarded **after** the migration runs gets a `users.clerk_user_id` entry but **no** `external_identity_links` row, so the re-pointed sale-sync resolver returns `user_unmapped` → 401 on every sale-sync attempt until a link exists.

**Resolution: ACCEPTED as an explicit deferral — documented here, no code added to the sign-in path.**

Rationale:
- D3 is scoped to re-anchoring identity resolution only (N-2). The spec already establishes that **the sign-in service re-point is a SEPARATE slice** (`operator-context-resolver.ts` header; `spec.md` E-2 / line 130) — `pos-operators.service.ts` still joins `clerk_user_id` at sign-in and is intentionally NOT touched by D3. Adding a link-insert to the sign-in pipeline now would do that separate slice's work, expanding D3 scope past its fence.
- The planned resolution is the sign-in re-point slice: once sign-in resolves via the link (the same join the sale-sync resolver already uses), new-operator provisioning is the natural place to auto-create/restore the link on first verified login (the HIGH-2 reactivating `linkExternalIdentity` is the ready provisioning primitive).

**Interim impact (must hold until the sign-in re-point slice ships):**
- A user **created after** the `0025` migration resolves fine on the **legacy sign-in** path (still `clerk_user_id`) but will get `user_unmapped` → uniform **401** on the **sale-sync** path until a link row exists for them.
- **Test-masking caveat:** the integration suites (`sale-auth.integration.spec.ts`, sign-in controller spec seeding) **hand-seed** `external_identity_links` rows for every fixture user, so they do not exercise the post-backfill new-user gap. A regression for the gap belongs in the sign-in re-point slice (where provisioning lands), not D3.

> NOTE for the orchestrator: HIGH-1 is resolved by **documentation, not code**. If the owner wants live new-user link provisioning **now** (rather than in the sign-in re-point slice), that is a deliberate scope expansion and should be requested explicitly — it would touch `pos-operators.service.ts`.

### HIGH-2 — `linkExternalIdentity` UPSERT now RE-ACTIVATES a disabled link (FIXED, RED-first)

**Finding:** the `ON CONFLICT (provider_key, issuer, subject) DO UPDATE` clause updated `email` + `last_verified_at` but NOT `status`/`disabled_at`. Re-linking a previously `disabled` subject returned the row id as success while the link stayed disabled — a silent semantic failure (the resolver's `WHERE status='active'` join still refuses the user).

**Fix:** the `DO UPDATE SET` now also sets `status = 'active', disabled_at = NULL` (both flipped together to satisfy the `external_identity_links_disabled_at_consistent` CHECK). The method's success return now reflects a usable, active link. (`enableIdentity` remains the explicit lifecycle seam; this only ensures re-link never silently returns a dead link.)

**Accepted boundary (option (a)):** reactivating a disabled link for a user who **already holds a different active link** raises `23505` from the `external_identity_links_one_active_per_user_uidx` partial-unique on the UPDATE. This is **fail-loud, not silent**, and is genuinely narrow in single-issuer v1 (one human = one Clerk subject). It is accepted for v1 and is the **sign-in re-point slice's** responsibility to handle gracefully once link provisioning becomes a live caller (e.g. disable-then-reactivate ordering). The D3 test covers only the single-link reactivation path.

**Test (RED-first):** new real-Postgres adapter-integration spec
`apps/api/test/auth/clerk-identity-provider.adapter.integration.spec.ts` — seeds a `disabled` link, calls the real adapter, asserts the returned row is `status='active'` / `disabled_at=NULL` and the active-link join finds exactly one row. RED against the old clause (`Received: "disabled"`), GREEN after the fix. (The docker-free unit spec cannot cover ON CONFLICT — it mocks `query`.)

### MEDIUM-3 — backfill issuer ↔ adapter `DEFAULT_CLERK_ISSUER` lockstep guard (ADDED)

**Finding:** the `0025` migration hardcodes the issuer literal; the adapter defaults to `DEFAULT_CLERK_ISSUER`. SQL cannot import TS, so nothing enforced the two strings stay in sync. (The runtime resolver join keys on `(provider_key, subject)` NOT issuer, so a drift cannot fail-close an operator today — but the stored `issuer` is part of the UNIQUE index and D8 lifecycle ops may key on it.)

**Fix:** a source-lockstep test in `apps/api/test/auth/clerk-identity-provider.adapter.unit.spec.ts` reads `0025_external_identity_links.sql` and asserts it contains `` `'${DEFAULT_CLERK_ISSUER}' AS issuer` ``. The migration is NOT edited (read-only guard); no shared-constant seed script (scope creep — SQL can't import TS). Verified RED on a temporary drift of the constant, GREEN on the real (matching) literal.

---

### Next recommended action
The remaining D3 work is unchanged by this pass. The named follow-up is the **sign-in service re-point slice** — re-point `pos-operators.service.ts` from `findUserByClerkSubject` onto the `external_identity_links` join, at which point new-operator link provisioning (HIGH-1) is implemented and regression-tested.
