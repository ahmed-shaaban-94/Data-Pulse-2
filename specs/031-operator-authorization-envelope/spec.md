# Draft D1+D2 — DP-2 Operator-Authorization Envelope: Mint & Return at Sign-In (closes the phantom guard)

> **DRAFT — NOT DISPATCHED.** Planning artifact under docs-only Orchestrator. No implementation, no contract, no migration, no gate mutation. Requires explicit scoped owner approval + G10 verification before any sibling-repo dispatch.

**Status:** SPECIFY-ONLY / DRAFT — for owner review. **gated — requires owner approval + G10 verification before any dispatch.** **Date:** 2026-06-11. **Owning repo:** Data-Pulse-2 (would dispatch here post-approval). **Deciders:** Owner (Ahmed Shaaban).

**Relation to 028:** Realizes 028 §9 + §6 (CM-1/CM-3) + §17 AC-13 + §20 ("DP-2 POS sale-sync authorization reconciliation, E-1/E-2 → target envelope"). 028 owns the boundary (authn-vs-authz separation, credential ownership, scope non-interchangeability) this draft conforms to; this draft does **not** re-specify the boundary — it consumes the G10 the boundary produces. It is the **keystone** drift item: 028 OQ-8 RESOLVED (Option-Y is a v1 bridge; target = an internal provider-neutral operator-authorization envelope minted at sign-in), and it closes drift **D2** (the phantom guard) in the same slice as **D1**.

---

> ### authoring & placement notes (owner can redirect)
>
> 1. **Docs-only.** Authored under the allowed `docs/**` surface of the Orchestrator, in the drafts area `docs/specs/drafts/028-followups/`. It is planning prose that would *feed a future Queue Item under G10*; it does not advance, mutate, or imply a kernel-queue node, gate, or status change.
> 2. **No `.specify/` tooling exists here**, so this was authored manually following the Spec-Kit structure (sections, success-criteria discipline, `[NEEDS CLARIFICATION]` → resolved-Clarifications / carried-OQ split), mirroring the house style of `docs/specs/028-project-auth-identity-access-boundary/spec.md`. No template-copy / `feature.json` / branch step ran (expected — none exists).
> 3. **This feeds a future Queue Item under G10, not a kernel mutation.** It is SPECIFY+CLARIFY-only (no `plan.md` / `tasks.md`): D1 is a **GATED** item whose upstream boundary (028) is signed but whose dispatch is not approved, so a plan or task list would be speculative. The envelope's wire format / TTL / refresh are 028-acknowledged plan-phase sub-questions and are carried as Open Questions, **not decided here**.
> 4. **Scope fence.** This draft does **not** change the identity-resolution join key (`WHERE clerk_user_id = $1`) — that is drift **D3** (the provider-neutral identity link), a separate foundation item. "Provider-neutral" here means the *client-presentable credential*, not the server-side resolution path.

---

## Clarifications

### Session 2026-06-11

> Auto-resolved from the signed 028 boundary + the adversarially-verified DAG in `docs/roadmap/auth-028-drift-map.md`. Each chosen option is the one consistent with 028's Clarifications (OQ-8) and the verified drift set; none decides a plan-phase sub-question (those are carried as OQ-n).

- Q: Is the target operator credential re-presentation of the existing Clerk JWT, or a distinct internal credential minted by DP-2? → A: **A distinct internal, provider-neutral operator-authorization envelope minted by DP-2 at sign-in** — 028 OQ-8 RESOLVED: the provider JWT is identity proof at sign-in only (028 §6 CM-1); the envelope is the durable sale-sync credential (028 §6 CM-3).
- Q: Is the minted envelope merely persisted server-side (today's behavior), or returned to the POS client? → A: **Minted AND returned to the client at sign-in** — this is the whole point of closing D2: today the `auth_tokens` `pos_operator` row is minted but its hash is never returned (E-2, ADR D8), so the canonical guard protects a phantom. The fix returns a client-presentable credential.
- Q: Which guard authorizes capture/void/refund at the target, and what happens to the Option-Y `PosOperatorSaleAuthGuard`? → A: **Re-wire capture/void/refund onto the canonical `pos_operator` authorization path; retire `PosOperatorSaleAuthGuard` for those routes** — the minted envelope IS the `scope==="pos_operator"` credential the canonical `PosOperatorAuthGuard` already demands (E-3). No dual-path is kept: retaining Option-Y alongside the envelope re-creates the 028 §19 DOC-3 contract↔runtime mismatch.
- Q: Are D1 and D2 the same slice or two slices? → A: **One slice** — minting+returning the envelope (D1) is exactly what makes the canonical guard's demanded credential obtainable (D2). Splitting them would ship a returnable credential nothing consumes, or a re-wired guard with no credential to satisfy it. The drift map (`auth-028-drift-map.md` D2 row) states "Closed by the same slice as D1."
- Q: Does this slice change the operator-resolution join key (`clerk_user_id`) or introduce the provider-neutral identity link? → A: **No — that is drift D3 (foundation), out of scope here** — the resolver continues to join on `clerk_user_id` for this slice (E-4); "provider-neutral" in this draft refers to the *client-presentable envelope*, not the server-side resolution path. D3 is recommended-first sequencing, **not** a hard gate on D1 (see Dependencies & sequencing).
- Q: Does this slice modify POS-Pulse, offline-PIN, or device-attestation behavior? → A: **No** — POS adoption of the envelope is drift **D5** (POS half of the keystone, downstream of D1); offline-PIN re-anchor is **D6**; the device-token-reverts-to-device-scoped change is **D7**. This draft is the DP-2 issuance↔use reconciliation only.

### Session 2026-06-12 — owner ratification of the carried Open Questions

> The OQ decision-options brief (`oq-decision-options.md`, PR #554) was reviewed by the owner. The DP-2-local OQs are **RESOLVED** as below; the two 028-boundary mirrors are **owner-confirmed DEFERRED to the 028 boundary** (not resolved here). This ratification authorizes advancing 031 from specify/clarify to **plan only** — it does **not** authorize implementation. G10 boundary is signed (planning precondition); gate clearance for dispatch remains an Orchestrator-side check.

- Q (OQ-1, format): Opaque revocable bearer, signed/structured token, or a new representation? → A: **RESOLVED — opaque revocable bearer.** Reuses the existing verification path (`AuthGuard` → `findActiveByRawToken` → `pos_operator` principal) and the existing `auth_tokens` hash/revocation model; no signing-key management; matches the stack's house pattern. The signed-token alternative was rejected (breaks DB-backed revocation, adds key management).
- Q (OQ-1 sub-fork): Return the currently-discarded raw token (1-A-i), or mint a distinct presentable opaque (1-A-ii)? → A: **RESOLVED — 1-A-i.** Return the raw value `issueOperatorSessionRow` already generates via `generateRawToken()` and currently discards after hashing; keep the existing `auth_tokens` hash + `revoked_at` revocation model unchanged. (Spec N-5 is hereby satisfied for this sub-fork.)
- Q (OQ-2, TTL): Reuse the existing 8h operator-session TTL, or a shorter envelope TTL? → A: **RESOLVED — reuse the existing 8h `OPERATOR_SESSION_TTL_MS`.** A shorter TTL only pays off with refresh (OQ-3); since refresh is deferred, 8h is the self-consistent choice.
- Q (OQ-3, refresh) = 028 OQ-9: Is the envelope refreshable; does POS store a refresh credential? → A: **DEFERRED to the 028 boundary (owner-confirmed).** Fallback for this slice = **no refresh** (today's `FR-POS-AUTH-5` behavior). The plan plans *around* this with an explicit "pending 028" placeholder; it is NOT resolved here.
- Q (OQ-4, multi-terminal) = 028 OQ-4: One operator across multiple terminals, or single-session? → A: **DEFERRED to the 028 boundary (owner-confirmed).** This slice inherits only the existing `takeover_required` / single-session-per-`(device, store)` behavior; the multi-distinct-device question stays upstream. NOT resolved here.
- Q (OQ-5, transport/scheme): Header/transport for the envelope on the sale routes? → A: **RESOLVED — `Authorization: Bearer <envelope>`** (the path `readBearerToken` already serves). The DOC-3 sale-route scheme **MUST** be a **new, distinct authorization-credential scheme** (e.g. `operator-authorization` / `pos-operator-envelope`) — it **MUST NOT** reuse 030's `operator-identity` scheme, which is identity-proof-only; reusing it would re-create the 028 §19 DOC-3 contract↔runtime mismatch.

## Evidence basis (verified this session, `origin/main`, 2026-06-11)

| Repo | `origin/main` HEAD | What was read |
|---|---|---|
| Data-Pulse-2 | `6588e86` (badge) / `0c57fed` (substantive, #544) | `apps/api/src/auth/pos-operator-sale-auth.guard.ts` (Option-Y guard, D1); `apps/api/src/auth/pos-operator-auth.guard.ts` (canonical scope guard, D2); `apps/api/src/pos-operators/pos-operators.controller.ts` + `.service.ts` + `dto.ts` (sign-in/sign-out + `auth_tokens` minting); `apps/api/src/catalog/sales/sales.controller.ts` (route↔guard wiring) |
| POS-Pulse | `0bb2ed8` (badge) / `b34932b` (substantive, #379) | referenced only for the consumer boundary (D5, out of scope) — not modified |
| Retail-Tower-Console | `97a7d42` (#33) | not read for this slice (out of scope) |
| Retail-Tower-ERP-Next-Connector | `bc768ad` (#27) | not read for this slice (out of scope) |
| Retail-Tower-Orchestrator | `main` (clean) | `docs/specs/028-…/spec.md`, `docs/roadmap/auth-028-drift-map.md`, `docs/gates/cross-repo-gates.md` (G10) |

Current-runtime facts pulled forward as **evidence** (kept distinct from *target* and *open decisions*):

- **E-1 (capture/void/refund authed by Option-Y).** `apps/api/src/catalog/sales/sales.controller.ts` wires `@UseGuards(PosOperatorSaleAuthGuard)` on `POST /api/pos/v1/sales` (`captureSale`, line 77/78), `POST /api/pos/v1/sales/:saleRef/void` (`recordVoid`, line 149/150), and `POST /api/pos/v1/sales/:saleRef/refund` (`recordRefund`, line 200/201). That guard (`apps/api/src/auth/pos-operator-sale-auth.guard.ts`) authenticates on a **raw Clerk JWT** (`Authorization: Bearer <clerk-jwt>`) **plus** `X-Device-Attestation`, runs the shared `OperatorContextResolver`, and **synthesizes** a `pos_operator`-scoped `Principal` server-side (its `scope: "pos_operator"` is assigned in code, not carried by a client credential). Its own header comment states: "operator sign-in never returns one [a `pos_operator` bearer] to the client." This is Option-Y (028 §6 operator-runtime row; drift-map D1).
- **E-2 (the phantom guard — D2).** Sign-in `apps/api/src/pos-operators/pos-operators.service.ts` `issueOperatorSessionRow(...)` runs `INSERT INTO auth_tokens (… scope, expires_at) VALUES (…, 'pos_operator', …)`, storing `token_hash = hashToken(generateRawToken())` and a TTL'd `expires_at` bound to `(tenant_id, user_id, device_id, store_id)` — but its header comment and the INSERT comment both state the raw value is **"never returned to the client (ADR D8)."** The sign-in response (`dto.ts` `PosOperatorSessionSummaryBody`) returns only `{ id, issued_at }` — no bearer/hash. Meanwhile the canonical `PosOperatorAuthGuard` (`apps/api/src/auth/pos-operator-auth.guard.ts`) requires `principal.kind === "token" && principal.scope === "pos_operator"` and is wired on `GET /api/pos/v1/sales/:saleRef` (`readSale`, `sales.controller.ts` line 113/114). So the canonical guard demands a credential the client can never present: **issuance and use are unreconciled.**
- **E-3 (the envelope IS the credential the canonical guard expects).** `PosOperatorAuthGuard` accepts exactly `principal.kind === "token"` with `scope === "pos_operator"` and rejects session cookies, `dashboard_api`, and `pos` scopes. The minted `auth_tokens` row already has `scope='pos_operator'` (E-2). Returning a client-presentable credential that resolves to that principal is what makes the canonical guard's gate satisfiable — closing the phantom by reconciling issuance↔use.
- **E-4 (resolution still joins on `clerk_user_id` — D3, NOT this slice).** Sign-in resolves the local user via `SELECT … FROM users WHERE clerk_user_id = $1` and the resolver verifies the provider token via `@clerk/backend`. This slice does **not** change that join; the provider-neutral identity link is drift D3 (foundation), recorded here only to fence scope.

> SC-09 discipline: nothing in this draft asserts the reconciliation is "done/merged." E-1/E-2/E-4 are recorded as **current-runtime drift facts** on `origin/main` `0c57fed`; the target is owner-ratified in direction (028 OQ-8) but **not implemented**.

## 1. Summary

Today on Data-Pulse-2 `origin/main` (`0c57fed`, #544), the POS sale-sync routes (`captureSale`, `recordVoid`, `recordRefund`) are authorized by **Option-Y** — a raw Clerk JWT plus `X-Device-Attestation`, from which DP-2 synthesizes a `pos_operator` principal server-side (E-1, D1). In parallel, operator sign-in mints an `auth_tokens` row scoped `pos_operator` but **never returns** a presentable credential to the POS client, while the canonical `PosOperatorAuthGuard` (wired on the sale-read route) demands `scope === "pos_operator"` — a credential the client cannot hold (E-2, the **phantom guard**, D2).

This draft specifies, at spec altitude, the **keystone reconciliation**: DP-2 mints **and returns** an internal, provider-neutral **operator-authorization envelope** at sign-in (the credential that satisfies the canonical guard, E-3), and **re-wires** capture/void/refund off the Option-Y `PosOperatorSaleAuthGuard` onto the canonical `pos_operator` authorization path. Issuance and use are reconciled in **one slice** (D1 + D2): the credential that sign-in returns is the credential the sale routes require, and the phantom guard stops protecting nothing.

The delta is deliberately small and **framed as "return + re-wire," not "build from zero"**: the `auth_tokens` `pos_operator` row, its scope binding, its TTL, and sign-out revocation already exist on `origin/main`. What is missing is (a) returning a client-presentable form of that credential at sign-in, and (b) pointing the sale routes' guard at it. The envelope's wire **format, TTL value, and refresh model** are 028-acknowledged plan-phase sub-questions, carried as Open Questions (§8), **not decided here**.

## 2. Goals

- **G-1.** Mint **and return** an internal, provider-neutral **operator-authorization envelope** to the POS client at successful sign-in (and at takeover-confirm), composed from the already-resolved identity + device trust + tenant/store access + POS eligibility + expiry (028 §6 CM-3). *(Closes D1 issuance half.)*
- **G-2.** Make the returned envelope the credential that the canonical `PosOperatorAuthGuard` (`scope === "pos_operator"`) already requires, so **issuance↔use reconcile** and the guard stops protecting a phantom. *(Closes D2.)*
- **G-3.** **Re-wire** `captureSale` / `recordVoid` / `recordRefund` off `PosOperatorSaleAuthGuard` (Option-Y) onto the canonical `pos_operator` authorization path, and **retire** `PosOperatorSaleAuthGuard` for those routes (no parallel Option-Y path retained). *(Closes D1 use half.)*
- **G-4.** Preserve the composed authorization predicate at the sale route — identity + device trust + tenant/store access + POS eligibility + non-expiry must all still hold; the envelope must not weaken any of them (028 §6 CM-1/CM-3, §7 sale-sync row).
- **G-5.** Preserve sale provenance and audit: the resolved `(tenant_id, store_id, user_id, device_id)` and a real `actor_user_id` on `sale.captured/voided/refunded` must remain available exactly as Option-Y produced them (E-1 audit posture).
- **G-6.** Provider-neutrality of the **client-presentable credential**: the envelope must carry no Clerk-specific field/shape; a provider switch must not require re-issuing or re-shaping it (028 §16; G10).
- **G-7.** Preserve the non-disclosing failure posture: missing/invalid envelope, revoked device, ineligible role, store-access miss all collapse to the same generic `401` (E-1 failure posture; 028 SR-6).

## 3. Non-goals

- **N-1.** No code, migration, OpenAPI/contract, package, lockfile, CI, generated-file, runtime-config, secret, env, or deployment change in this task. (Orchestrator is docs-only; this is a DRAFT.)
- **N-2.** **No change to the identity-resolution join key.** The `WHERE clerk_user_id = $1` resolution and `@clerk/backend` verification stay as-is (E-4); the provider-neutral identity link / `IdentityProviderPort` is drift **D3**, a separate foundation item.
- **N-3.** **No POS-Pulse change.** The POS client adopting/presenting the envelope is drift **D5** (downstream of D1); not authored here.
- **N-4.** No offline-PIN, device-attestation-storage, or device-token-role change. Re-anchoring the offline-PIN store is **D6**; the device token reverting to device-scoped is **D7**.
- **N-5.** **No decision on envelope wire format, TTL value, or refresh/refresh-token-storage model** — these are plan-phase sub-questions (§8 OQ-1/OQ-2/OQ-3), explicitly carried, not resolved. In particular, "return the raw token that today's `issueOperatorSessionRow` discards" is **not** prescribed; that is the format OQ.
- **N-6.** No Console, Connector, or ERPNext change. No new gate, kernel node, or status mutation in the Orchestrator.

## 4. Current vs target (the reconciliation, at altitude)

| Aspect | Current runtime (`origin/main` `0c57fed`) | Target (this draft) |
|---|---|---|
| Sale-sync credential (capture/void/refund) | Raw Clerk JWT + `X-Device-Attestation`; DP-2 synthesizes `pos_operator` principal in `PosOperatorSaleAuthGuard` (E-1) | Client presents the minted **operator-authorization envelope**; resolves to a real `pos_operator` principal |
| Guard on sale-write routes | `PosOperatorSaleAuthGuard` (Option-Y) | Canonical `pos_operator` authorization path (`PosOperatorSaleAuthGuard` retired for these routes) |
| Canonical `PosOperatorAuthGuard` (on `readSale`) | Demands `scope === "pos_operator"` — unobtainable by the client (E-2, phantom) | Satisfied by the returned envelope; no longer phantom |
| Sign-in response | `{ operator, operator_session: { id, issued_at } }` — no presentable credential (E-2, ADR D8) | Same + a **client-presentable envelope** (format = OQ) |
| `auth_tokens` `pos_operator` row | Minted, scope-bound to `(tenant,user,device,store)`, TTL'd, hash discarded (E-2) | Reused as the envelope's server-side state of record; sign-out revocation (`UPDATE auth_tokens`) unchanged |
| Resolution join key | `WHERE clerk_user_id = $1` (E-4) | **Unchanged** (D3, not this slice) |

## 5. Envelope (seam description — NOT a wire contract)

> Described at spec altitude. The concrete wire shape, header/transport, TTL value, and refresh model are Open Questions (§8) for the owning repo's plan phase, not decided here.

- **Issuer / authority:** Data-Pulse-2 (the authorization boundary, 028 §0/§5). Minted only after the full sign-in predicate passes (identity verified → user resolved → device resolved & non-revoked → membership/role → store eligibility → non-expiry).
- **Subject binding:** the same tuple the `auth_tokens` row already binds — `(tenant_id, store_id, user_id, device_id)` — so the resolved principal carries a real `actor_user_id` (audit, G-5) and the composed predicate (G-4) is enforceable at the route.
- **Scope:** `pos_operator` (matches the canonical guard's required scope, E-3). Scope non-interchangeability is preserved (028 SR-10): the envelope is not valid on read-down, dashboard, service, or admin surfaces.
- **Provider neutrality:** the envelope carries no Clerk-specific claim/field; it is DP-2-issued and DP-2-verifiable independent of the provider (G-6, 028 §16). The provider JWT remains identity proof **at sign-in only** (028 §6 CM-1).
- **Lifecycle:** minted at sign-in and at takeover-confirm; expiry uses the existing `auth_tokens.expires_at` (TTL value = OQ); revoked via the existing sign-out path (`UPDATE auth_tokens … revoked_at`) and by device/user/store revocation reconciliation (028 §9). Refresh model = OQ.
- **Server-side state of record:** the existing `auth_tokens` `pos_operator` row. This draft does **not** assert a new table or column; whether the returned credential is the row's existing opaque material or a new representation is the format OQ (§8 OQ-1).

## 6. Route / surface re-wiring

| Route (operationId) | Current guard | Target guard | Note |
|---|---|---|---|
| `POST /api/pos/v1/sales` (`captureSale`) | `PosOperatorSaleAuthGuard` (Option-Y) | canonical `pos_operator` path | re-wire; composed predicate preserved |
| `POST /api/pos/v1/sales/:saleRef/void` (`recordVoid`) | `PosOperatorSaleAuthGuard` | canonical `pos_operator` path | re-wire; refund/void authz = same as the sale (028 §7) |
| `POST /api/pos/v1/sales/:saleRef/refund` (`recordRefund`) | `PosOperatorSaleAuthGuard` | canonical `pos_operator` path | re-wire |
| `GET /api/pos/v1/sales/:saleRef` (`readSale`) | canonical `PosOperatorAuthGuard` (phantom today) | unchanged guard, now satisfiable | the envelope makes its `scope` demand reachable (E-3) |
| `POST /api/pos/v1/operators/sign-in` (`signIn`) | Clerk JWT + device attestation | unchanged authn; **adds envelope to the response** | issuance half |
| `POST /api/pos/v1/operators/takeover/confirm` | Clerk JWT + device attestation | unchanged authn; returns the envelope | takeover yields a usable credential too |
| `POST /api/pos/v1/operators/sign-out` (`signOut`) | Clerk JWT | unchanged; existing `auth_tokens` revoke | revocation already present |

> The contract-name cleanup (`clerkJwt` → role-named scheme on the sale routes) **co-travels with this slice** for the re-wired routes (028 §19 DOC-3): documenting `pos_operator` while the runtime still enforced a Clerk JWT would create the very mismatch DOC-3 exists to kill. The broader DOC-1/2/4 cleanup is the separate, additive drift **D4** (startable in parallel, not gated on D1).

## 7. Acceptance criteria

- **A-1.** Sign-in (and takeover-confirm) returns a **client-presentable operator-authorization envelope** in addition to today's `{ id, issued_at }` summary.
- **A-2.** The returned envelope, when presented by the client, resolves to a `principal` that satisfies the canonical `PosOperatorAuthGuard` (`kind === "token"`, `scope === "pos_operator"`). *(D2 closed.)*
- **A-3.** `captureSale`, `recordVoid`, `recordRefund` are authorized via the canonical `pos_operator` path; `PosOperatorSaleAuthGuard` is no longer wired on them and no parallel Option-Y path remains. *(D1 closed.)*
- **A-4.** The composed predicate (identity + device trust + tenant/store access + POS eligibility + non-expiry) still gates every sale-write route; a device-only or provider-JWT-only request still cannot post a sale (028 §18 refusal rows preserved).
- **A-5.** Sale provenance and audit are unchanged: `sale.captured/voided/refunded` still record a real `actor_user_id` and the resolved `(tenant,store,user,device)` scope.
- **A-6.** The envelope carries no Clerk-specific field; verifying it does not require the provider, and the operator-resolution join key is unchanged (D3 untouched).
- **A-7.** Failure posture preserved: every refusal collapses to the same generic `401`; no enumeration; no token/secret in logs (028 SR-2/SR-6).
- **A-8.** No envelope wire-format, TTL-value, or refresh-model decision is asserted as final — those remain Open Questions for the owning repo's plan phase.
- **A-9.** No implementation, contract, or migration was authored in this draft (Orchestrator docs-only).

## Dependencies & sequencing

> Cites the verified DAG in `docs/roadmap/auth-028-drift-map.md` ("Verified dependency DAG" + "Recommended build order"). Hard gate vs recommended-sequencing are kept distinct.

- **Gate (hard):** **G10 — Identity & Access Boundary Gate.** This is an auth/identity/access-touching item, so it **must** list G10; G10's producer (Orchestrator 028) is signed (Clarifications Session 2026-06-11), but **dispatch requires explicit scoped owner approval + G10 verification** against 028 §5/§6/§7. The residual plan-phase OQs (028 OQ-2/3/4/9/11) are non-blocking for G10.
- **DAG position:** **D1 is the keystone root** of the DP-2 spine. Its hard dependency is **G10 only**. The verified DAG draws hard edges **D1 → D5 → D7** (downstream) and **closes D2 in the same slice** as D1. The DAG deliberately does **not** draw a hard `D3 → D1` edge: D3 (the provider-neutral identity link) concerns the server-side resolution join, while D1's provider-neutrality concerns the *client-presentable envelope*. D3 is **recommended-first sequencing** (build order step 1, the seam D6/D8 key off), **not a gate on D1**.
- **Downstream consumers (out of scope here):** **D5** (POS adopts/presents the envelope) is hard-gated on D1; **D7** (device token reverts to device-scoped) follows D5; **D6** (POS offline-PIN re-anchor) needs D3 **and** the D1/D5 envelope carrying `user_id` (the DAG's surfaced new edge).
- **Parallelizable, not gated on this item:** **D4** (DP-2 contract cleanup, DOC-1/2/4) is additive and startable now (D1→D4 was adversarially **refuted**); the DOC-3 sale-route rename co-travels with this slice only.

## Open questions (status after owner ratification, Session 2026-06-12)

> The DP-2-local OQs were **RESOLVED** by owner ratification (Clarifications Session 2026-06-12); the two 028-boundary mirrors are **owner-confirmed DEFERRED** to the 028 boundary. The plan phase consumes the resolved answers and plans *around* the deferred ones with explicit "pending 028" placeholders.

- **OQ-1 (envelope wire format) — RESOLVED.** Opaque revocable bearer, **sub-fork 1-A-i**: return the raw value `issueOperatorSessionRow` already generates via `generateRawToken()` and currently discards after hashing; keep the existing `auth_tokens` hash + `revoked_at` revocation model unchanged. (See Clarifications 2026-06-12.)
- **OQ-2 (TTL) — RESOLVED.** Reuse the existing 8h `OPERATOR_SESSION_TTL_MS`; one TTL governs both the sign-in session and the presented envelope. (Revisit toward a shorter TTL only if OQ-3 later adopts refresh.)
- **OQ-3 (refresh model) — = 028 OQ-9 — DEFERRED to the 028 boundary (owner-confirmed).** Slice fallback = **no refresh** (today's `FR-POS-AUTH-5`). Still genuinely open upstream; the plan carries it as a "pending 028" placeholder, NOT resolved.
- **OQ-4 (multi-terminal / takeover) — = 028 OQ-4 — DEFERRED to the 028 boundary (owner-confirmed).** This slice inherits only the existing `takeover_required` / single-session-per-`(device, store)` behavior; the multi-distinct-device question stays upstream, NOT resolved.
- **OQ-5 (transport / scheme) — RESOLVED.** `Authorization: Bearer <envelope>` (the path `readBearerToken` already serves). The DOC-3 sale-route scheme **MUST** be a **new, distinct authorization-credential scheme** (e.g. `operator-authorization` / `pos-operator-envelope`) and **MUST NOT** reuse 030's identity-proof-only `operator-identity` scheme. (Contract-phase work, gated G2.)
- **Referenced 028-open, non-blocking for this slice:** 028 OQ-2 (offline manager override), 028 OQ-3 (PIN retry-lock), 028 OQ-11 (break-glass for pilot) remain open at the 028 boundary and do not gate this DP-2 issuance↔use reconciliation.

---

> **Docs-only (SPECIFY + CLARIFY + PLAN).** This artifact records and reconciles a boundary-consuming follow-up; it does not implement, define a contract, or create a migration. The OQs are resolved/deferred by owner ratification (Clarifications Session 2026-06-12), which authorized advancing to **plan only** — see [`plan.md`](./plan.md). `tasks.md` is **not** authored and no implementation is dispatched without a further explicit, scoped owner approval after G10 dispatch-clearance.
