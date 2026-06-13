# Feature Specification: Surface Provider-Neutral `user_id` on the POS-Facing Operator Response

**Feature Branch**: `feat/033-pos-facing-user-id-surface`

**Created**: 2026-06-13

**Status**: PLANNING — owner cleared the Materialize Stop Gate on 2026-06-13 (clarify → plan → tasks → analyze → review chain authorized). G10 re-verified against `origin/main` code at plan-start (E-1/E-3/E-4 confirmed in `dto.ts` + `pos-operators.service.ts`; `user_id` is identity data, not a credential/scope token). Planning chain is **docs-only** — no code, contract YAML, or migration is authored here; the implementation dispatch remains a separate step. (Originally SPECIFY-ONLY / DRAFT under a scoped Retail Tower Orchestrator dispatch.)

**Input**: Surface the DP-2 provider-neutral `user_id` (= `users.id`, the 028 §16 identity key) on the POS-facing sign-in / operator-session response, so the POS terminal can re-anchor its offline-PIN store (POS-017) off a provider-neutral identifier instead of the provider-coupled `clerk_user_id`.

**Relation to 028 / G10:** Realizes the 028 §16 provider-independence / anti-lock-in target by publishing the §16 `user_id` to the POS edge. 028 owns the auth/identity boundary (authn-vs-authz separation, credential ownership, scope non-interchangeability, provider independence); this feature **consumes** the G10 that boundary produces and does **not** re-specify it. It is the missing last hop of the §16 chain: 029 (PR #550) built the `(provider_key, issuer, subject) → user_id` link server-side; 031 (PR #559) shipped the operator-authorization envelope; this feature surfaces the neutral key on the response the operator already receives.

---

## Evidence basis (verified read-only on `origin/main`, 2026-06-13)

- **E-1 — the POS-facing operator block today carries `clerk_user_id`, NOT the neutral key.** `apps/api/src/pos-operators/dto.ts` (`PosOperatorSummaryBody`): `id` is documented "`users.clerk_user_id` (Clerk subject), NOT `users.id` (ADR D4)". The block is `{ id, display_name, role, tenant_id, branch_id }`. There is no `user_id` field on any POS-facing response.
- **E-2 — the provider-neutral key is `users.id`.** `packages/db/drizzle/0025_external_identity_links.sql` (029, PR #550) maps `(provider_key, issuer, subject) → user_id`, where `user_id` FKs `users(id)`. `users.clerk_user_id` is reclassified as a v1 bridge column behind the link (retained, off the join path, not dropped).
- **E-3 — `users.id` is ALREADY in scope at every response-build site.** `apps/api/src/pos-operators/pos-operators.service.ts`: the user row is SELECTed with its `id` (the `findUserByClerkSubject` query returns `id, email, display_name, clerk_user_id, deleted_at`); `userRow.id` is already used for `userId`, audit `actor_user_id`, and ownership checks. The three response-build sites (sign-in success, second/admin path, takeover-confirm including idempotent replay) each emit the operator block with `id: userRow.clerk_user_id ?? ""` and have `userRow.id` in scope.
- **E-4 — the envelope is OPAQUE.** `dto.ts` `PosOperatorSessionSummaryBody.envelope` is "the client-presentable operator-authorization ENVELOPE … the opaque `pos_operator` bearer". A consumer cannot parse `user_id` out of it; the neutral key must be a readable sibling field, not an envelope claim.
- **E-5 — consumer need.** POS-Pulse `specs/017-offline-pin-reanchor/spec.md` §5: the neutral `user_id` "is not queryable by POS on its own … it arrives as data on the online path … at online sign-in, the DP-2 operator-authorization envelope … carries the operator's `user_id`". POS-017 is IMPLEMENTATION-BLOCKED until this delivery exists.

---

## Clarifications

### Session 2026-06-13

> Auto-resolved from the signed 028 boundary, the 029/031 shipped code, and the POS-017 consumer spec. Each chosen option is the one consistent with the verified evidence above; none decides a plan-phase sub-question (those are carried as Open Questions).

- Q: Should `user_id` be encoded inside the operator-authorization envelope, or surfaced as a readable response field? → A: **A readable response field.** The envelope is an opaque bearer (E-4); POS cannot parse a token. POS-017 needs `user_id` as readable data to write into a local primary key. "Carried in the envelope" in the POS-017 spec means "in the response payload that also delivers the envelope," not "inside the bearer string."
- Q: On which response object does `user_id` belong — the operator-identity block (`PosOperatorSummary`) or the session block (`PosOperatorSessionSummary`)? → A: **The operator-identity block (`PosOperatorSummary`).** `user_id` is a durable identity attribute, not session state. The session block's `envelope` is null on an idempotent takeover-confirm replay; placing `user_id` there would force a null-handling rule. The operator block is always present on every `signed_in` response (sign-in, admin path, takeover-confirm including replay), so `user_id` is never null when operator identity is delivered.
- Q: Does this feature change identity resolution, mint anything, or touch the envelope's contents? → A: **No.** It surfaces a value already loaded on the user row (E-3). It does not change the `clerk_user_id` join key (that is 029's concern), does not mint or alter the envelope (031's concern), and adds no new credential or scope.
- Q: Is a schema migration required? → A: **No.** `users.id` already exists and is already SELECTed (E-3). This is read-and-surface. It does not depend on `external_identity_links` being backfilled — `userRow.id` is the users-table primary key, always present, independent of the 029 link table's deferred provisioning.
- Q: Is `clerk_user_id` removed from the response? → A: **No.** `id` (= `clerk_user_id`) is retained as the v1 bridge field (mirrors 028 §16 / OQ-6's bridge-column pattern). `user_id` is added alongside it. Existing POS readers (016) that read `id`/`envelope` are unaffected — the new field is additive and backward-compatible.

### Carried Open Questions (plan-phase — NOT decided here)

- **OQ-033-1 (field nullability under deleted/unmapped users):** the response is only built for a resolved, non-deleted user, so `user_id` is always present on a `signed_in` response. Whether any non-`signed_in` response path needs to express `user_id` is a plan-phase check against the full response union, not a spec decision.
- **OQ-033-2 (contract field requiredness):** whether `user_id` is `required` in the OpenAPI schema vs optional-during-a-rollout-window is a plan-phase decision tied to how POS adopts it (POS-017 sequencing). The neutral key is always available server-side; the only question is client-rollout ordering.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — POS receives the provider-neutral operator identity at sign-in (Priority: P1)

A cashier or manager signs in on a paired POS terminal. The DP-2 sign-in response delivers the operator's durable, provider-neutral `user_id` (the §16 identity key) alongside the existing identity proof and envelope, so the terminal can key local operator-scoped records on a provider-independent identifier.

**Why this priority**: This is the entire feature. Without it, POS-017 (offline-PIN re-anchor) cannot begin — the neutral key has no delivery path to the terminal.

**Independent test**: Sign in a seeded operator; assert the response operator block contains `user_id` equal to that operator's `users.id` (NOT their `clerk_user_id`), as a well-formed UUID.

**Acceptance Scenarios**:
1. **Given** a seeded operator whose `users.id` is U and `clerk_user_id` is C, **When** they sign in successfully, **Then** the operator block contains `user_id == U` and `id == C` (bridge retained).
2. **Given** the same operator, **When** the response is built via the manager/admin path, **Then** `user_id == U` is present.
3. **Given** an operator confirming a takeover, **When** the takeover-confirm succeeds, **Then** `user_id == U` is present in the operator block.
4. **Given** a takeover-confirm that is an idempotent replay (envelope is null), **When** the replay response is built, **Then** `user_id == U` is STILL present and non-null (it is `users.id`, not a hash-once secret).

### User Story 2 — Existing POS clients are unaffected by the additive field (Priority: P2)

A POS client built before this change (e.g. the feat(016) client that reads `id`/`envelope`) continues to function unchanged when the response gains a `user_id` field.

**Why this priority**: The field is additive at the application level (no existing field changes meaning). **Caveat (analyze/review finding):** the `PosOperatorSummary` schema declares `additionalProperties: false` (and the contract comments note strictness is enforced on both sides). A consumer that validates strictly against the *old pinned schema* would reject a response carrying `user_id` as a disallowed property — even though it never reads the field. Backward-compatibility therefore holds for **lenient** consumers; for a **strict** consumer it requires a coordinated contract-pin bump (the schema bump + the POS-Pulse pin update land together — a minor coordinated release, not a code-behavior break). This is dispositioned in plan §OQ-033-2 and scoped into tasks T1/T4.

**Independent test**: Validate the new response against the *actual old `PosOperatorSummary` schema* (5 required fields, `additionalProperties: false`) to characterize the strict-mode boundary, AND deserialize with a lenient pre-change client to confirm the field is ignored.

**Acceptance Scenarios**:
1. **Given** a lenient client that reads only `id`, `display_name`, `role`, `tenant_id`, `branch_id`, **When** it receives a response carrying the new `user_id`, **Then** it parses successfully and ignores the new field.
2. **Given** a strict validator pinned to the *old* `PosOperatorSummary` schema (`additionalProperties: false`), **When** it validates a response carrying `user_id`, **Then** it rejects — which is why the contract bump and the POS-Pulse pin update are a coordinated pair (T1).

### Edge Cases

- **Replay with null envelope** must still carry `user_id` (covered by US1 scenario 4) — `user_id` is identity, not session-state.
- **No `user_id` may leak into the opaque envelope** — the envelope bytes are unchanged by this feature; `user_id` is a sibling response field only.
- **`user_id` is an internal UUID, not a secret** — it is the §16 provider-neutral identity key (already used server-side for audit/ownership); surfacing it introduces no recoverable secret to the response.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-033-1**: The POS-facing operator-identity object (`PosOperatorSummary`) MUST include a `user_id` field carrying the operator's provider-neutral `users.id` (the 028 §16 identity key).
- **FR-033-2**: `user_id` MUST be populated from the user row already loaded when the response is built (no new resolution path, no new query).
- **FR-033-3**: `user_id` MUST be present and non-null on every `signed_in` response — sign-in success, manager/admin path, and takeover-confirm including idempotent replay.
- **FR-033-4**: The existing `id` field (= `clerk_user_id`) MUST be retained as the v1 bridge identifier; this feature is additive and MUST NOT remove or repurpose it.
- **FR-033-5**: `user_id` MUST NOT be encoded inside the opaque operator-authorization envelope; it is a readable response field.
- **FR-033-6**: This feature MUST NOT introduce a schema migration, change identity resolution, or alter the envelope's contents.

### Non-Goals / Out of Scope

- **N-033-1**: The POS-017 offline-PIN re-anchor itself (a POS-Pulse change, separately owner-gated).
- **N-033-2**: Provisioning or backfilling `external_identity_links` (029-deferred; a separate DP-2 slice). This feature surfaces `users.id`, which exists independent of the link table.
- **N-033-3**: Any change to the operator-authorization envelope's minting, format, or contents (031's concern).
- **N-033-4**: Any change to the `clerk_user_id`-based identity-resolution join key (029's concern).
- **N-033-5**: Removing `clerk_user_id` / retiring the bridge (a later, separate decision).

### Key Entities

- **`PosOperatorSummary` (response object)**: the POS-facing operator-identity block. Gains `user_id` (provider-neutral, `users.id`); retains `id` (Clerk subject, v1 bridge), `display_name`, `role`, `tenant_id`, `branch_id`.
- **`users.id`**: the provider-neutral identity key. Already the FK target of `external_identity_links.user_id` (029). Already loaded at every response-build site.

---

## Success Criteria *(mandatory)*

- **SC-033-1**: A signed-in operator's response carries `user_id == users.id` (verified by test against a seeded row), distinct from `clerk_user_id`.
- **SC-033-2**: `user_id` is present and non-null on all four `signed_in` response paths (sign-in, admin, takeover-fresh, takeover-replay).
- **SC-033-3**: The change is additive at the application level (no existing field changes meaning) and backward-compatible for **lenient** consumers — a pre-change POS client that ignores unknown fields still deserializes the response. For **strict** consumers, the `PosOperatorSummary` schema's `additionalProperties: false` means the contract-pin bump and the POS-Pulse pin update ship as a coordinated pair (see User Story 2 caveat + plan §OQ-033-2). No code-behavior break either way.
- **SC-033-4**: No schema migration is introduced (G3 untriggered); no envelope-content change; no resolution-path change.
- **SC-033-5**: POS-017's `user_id`-delivery dependency is satisfied — the neutral key now reaches the terminal as readable response data.

---

## Gate posture *(for the future implementation dispatch — not cleared here)*

- **G10** (Identity & Access Boundary): CONSUMED. Producer ORCH-028 (PR #85 / `76cfcc3`) is merged; boundary decisions signed. `user_id` is identity data (not a credential, not a scope-bearing token), surfaced on the response the operator already receives — no scope-interchange; producer-exclusion respected. To be re-verified at the implementation dispatch.
- **G2** (Contract): the implementation extends the existing `pos-operators.openapi.yaml` POS-facing contract with an additive field (backward-compatible). Both-sides confirmation: the POS-017 consumer need is the cross-side requirement.
- **G3** (Migration): NOT triggered. No schema change.
- **G9** (Rollout): not a rollout; not required for implementation/merge.

> **Materialize Stop Gate — CLEARED (2026-06-13).** The SPECIFY phase boundary that originally halted this document has been lifted by explicit owner approval; `plan.md` and `tasks.md` are now authored alongside this spec (clarify → plan → tasks → analyze → review chain). G10 was re-verified against `origin/main` code at plan-start (plan §G10). **The planning chain remains docs-only — no code, contract YAML, or migration is authored.** The implementation dispatch (executing `tasks.md`, including the `[GATED]` T1 contract edit) is still a separate step, subject to the standing gates and a final G10 re-confirm at execution, per the Orchestrator's DP-033 queue item.
