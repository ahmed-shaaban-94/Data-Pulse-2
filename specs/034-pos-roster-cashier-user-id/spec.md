# Feature Specification: Surface Provider-Neutral `user_id` on the POS Cashier Roster

**Feature Branch**: `034-pos-roster-cashier-user-id`

**Created**: 2026-06-13

**Status**: Draft

**Input**: Surface the provider-neutral `user_id` (= `users.id`, the 028 §16 identity key) on the POS-facing **cashier roster** entry (`PosRosterCashierEntry`), so the POS terminal can provision each cashier's offline-PIN record keyed on a provider-independent identifier from creation (POS-019), and ultimately re-anchor the existing store (POS-017).

**Relation to 028 / 033 / G10:** This is the **cashier-roster sibling of 033**. 033 surfaced the §16 `user_id` on `PosOperatorSummary` (the *signing-in operator's* identity). But the offline-PIN store is keyed to the **cashier**, a different principal, and the only POS-facing contract carrying cashier identity — `PosRosterCashierEntry` — still exposes only the Clerk subject. This feature closes that gap. It **consumes** the G10 boundary 028 produces and does **not** re-specify it; like 033, it surfaces a value already loaded server-side and introduces no migration, no resolution change, and no new query.

---

## Evidence basis (verified read-only on `origin/main`, head `88c8d3d`, 2026-06-13)

- **E-1 — the POS cashier roster carries only the Clerk subject today.** `packages/contracts/openapi/pos-operators.openapi.yaml` → `PosRosterCashierEntry` (≈ lines 510–537) is `required: [id, display_name, role]`, `additionalProperties: false`, with `id` documented as the **Clerk subject** (`users.clerk_user_id`). There is no `user_id` field. The DTO mirror `apps/api/src/pos-operators/dto.ts` → `PosRosterCashierEntry` (≈ line 138) matches: `{ id, display_name, role }`.
- **E-2 — the provider-neutral key (`users.id`) is ALREADY in scope at the roster build site.** `apps/api/src/pos-operators/pos-operators.service.ts` → `findCashiersByStore` (≈ lines 798–832) runs `JOIN users u ON u.id = m.user_id` (≈ line 809) — the neutral `user_id` **is** the `u.id` it already joins on. The query SELECTs `u.clerk_user_id, u.display_name` (≈ line 806) and maps each row to `{ id: row.clerk_user_id, display_name, role }` (≈ lines 827–831). Adding `user_id` is selecting `u.id` and mapping `user_id: row.id`.
- **E-3 — no `external_identity_links` provisioning is needed (same as 033).** `users.id` is the users-table primary key, always present, independent of the 029 link table's deferred provisioning (`linkExternalIdentity` has no live runtime caller). The roster resolves cashiers via the `memberships`/`users` join, not via the link table — so the neutral key is available regardless of link backfill state.
- **E-4 — 033 surfaced this for the operator but explicitly scoped the roster OUT.** `specs/033-pos-facing-user-id-surface/spec.md` touched `PosOperatorSummary` only. Its SC-033-5 ("POS-017 UNBLOCKED") is correct for *operator-scoped* local records but does not cover the cashier-PIN store — the gap this feature fills.
- **E-5 — consumer need (born-neutral, already merged).** POS-Pulse 019 (`feat(019)`, merged) builds the cashier-PIN **create** path keyed on the provider-neutral `user_id` from creation; until this roster field is live, POS-019 truthfully refuses provisioning as `not_ready`. POS-017 (offline-PIN re-anchor) then re-keys any legacy rows. See POS-Pulse `specs/017-offline-pin-reanchor/OUTBOX-DP2-cashier-user_id.md` + `UNBLOCK-PLAN.md` (this is **Step 1** of its 2→1→3 sequence; Step 2 / 019 is done).

---

## Clarifications

### Session 2026-06-13

> Auto-resolved from the verified evidence above and the shipped 033 precedent. Each choice mirrors 033's resolution for the operator object, applied to the roster object.

- Q: On which POS-facing object does the cashier's `user_id` belong? → A: **`PosRosterCashierEntry`** — the only POS-facing contract carrying cashier identity (E-1). The roster is where POS reads each cashier to provision (E-5).
- Q: Does this require resolving or provisioning `external_identity_links`? → A: **No.** `users.id` is already loaded at the roster build site via the `users` join (E-2/E-3); this is read-and-surface, independent of the deferred 029 link provisioning. (Identical to 033 Clarification Q4.)
- Q: Is a schema migration required? → A: **No.** `users.id` already exists and is already joined/SELECTed-adjacent (E-2). No new column, no new table.
- Q: Is `id` (the Clerk subject) removed from the roster entry? → A: **No.** `id` (= `clerk_user_id`) is retained as the v1 bridge / identity-continuity field (used in `active-session` + audit `acting_operator_id`); `user_id` is added alongside it. Additive and backward-compatible for lenient consumers.
- Q: Requiredness of the new field? → A: `user_id` SHOULD be `required` on `PosRosterCashierEntry` for v1 (every rostered cashier resolves to a `users` row, so `u.id` is always present). The strict-consumer / contract-pin coordination is a plan-phase note (mirrors 033 OQ-033-2), not a spec blocker — POS-Pulse validates the operator/roster path leniently (allowlist reader), so the additive field is wire-safe.

**`/speckit-clarify` pass (2026-06-13): no further critical ambiguities.** A structured ambiguity scan (scope, data model, identity, interaction, non-functional, integration, edge cases, constraints, terminology, completion) found all categories Clear except the strict-vs-lenient consumer coordination, which is already dispositioned above as a plan-phase release-ordering note (not a spec decision). No new questions asked; the 5 Q/A above (auto-resolved from the shipped 033 precedent) stand.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — POS reads each cashier's provider-neutral identity from the roster (Priority: P1)

A POS terminal fetches the branch cashier roster (e.g. to render the cashier picker, or for a manager to provision a cashier's first PIN). Each roster entry now carries the cashier's durable, provider-neutral `user_id` (the §16 identity key) alongside the existing Clerk-subject `id`, so the terminal can key local cashier-scoped records on a provider-independent identifier.

**Why this priority**: This is the entire feature. Without it, POS-019 (cashier-PIN provisioning) cannot create a born-neutral row — the neutral key has no delivery path to the terminal for the cashier principal, and POS-017 stays blocked.

**Independent test**: Seed a cashier whose `users.id` is U and `clerk_user_id` is C, in a store with a paired terminal; fetch the roster; assert the cashier entry contains `user_id == U` (a well-formed UUID) and `id == C`.

**Acceptance Scenarios**:
1. **Given** a seeded cashier with `users.id` U and `clerk_user_id` C in the resolved branch, **When** the POS roster is fetched, **Then** that cashier's entry contains `user_id == U` and `id == C` (bridge retained).
2. **Given** multiple cashiers in the branch, **When** the roster is fetched, **Then** every entry carries its own non-null `user_id` from `users.id`.
3. **Given** a cashier with no `clerk_user_id` IS-NOT-NULL match (already excluded by the existing query filter), **When** the roster is fetched, **Then** they remain excluded — this feature does not change roster membership, only adds a field to included entries.

### User Story 2 — Existing POS roster clients are unaffected by the additive field (Priority: P2)

A POS client built before this change (reading `{ id, display_name, role }`) continues to function when the roster entry gains `user_id`.

**Why this priority**: Additive at the application level. **Caveat (mirrors 033):** `PosRosterCashierEntry` declares `additionalProperties: false`; a strict validator pinned to the *old* schema would reject a response carrying `user_id`. Backward-compatibility holds for **lenient** consumers (POS-Pulse's roster handler is an allowlist reader — it strips unknown fields by construction, so it is wire-safe today and will thread `user_id` only after it widens its allowlist). For strict consumers the schema bump + pin update are a coordinated pair.

**Independent test**: Validate the new roster response against the *old* `PosRosterCashierEntry` schema to characterize the strict boundary; AND deserialize with a lenient client to confirm the field is ignored when not read.

**Acceptance Scenarios**:
1. **Given** a lenient client reading only `{ id, display_name, role }`, **When** it receives a roster carrying `user_id`, **Then** it parses successfully and ignores the new field.
2. **Given** a strict validator pinned to the old `PosRosterCashierEntry`, **When** it validates an entry carrying `user_id`, **Then** it rejects — hence the coordinated contract-pin pair.

### Edge Cases

- **`user_id` is an internal UUID, not a secret** — the §16 provider-neutral identity key, already used server-side; surfacing it on the roster introduces no recoverable secret (same disposition as 033).
- **Roster membership is unchanged** — the existing `store_staff` role + `store_access` + non-null filters are untouched; this feature only adds a field to entries already returned.
- **No PIN / credential data** — the roster carries identity only; this feature adds no credential, hash, or token (FR-031 minimum-disclosure preserved).

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-034-1**: `PosRosterCashierEntry` MUST include a `user_id` field carrying the cashier's provider-neutral `users.id` (the 028 §16 identity key).
- **FR-034-2**: `user_id` MUST be populated from the `users` row already joined when the roster is built (`findCashiersByStore`) — no new resolution path, no new query, no `external_identity_links` lookup.
- **FR-034-3**: `user_id` MUST be present and non-null for every roster entry returned.
- **FR-034-4**: The existing `id` field (= `clerk_user_id`) MUST be retained as the v1 bridge / identity-continuity identifier; this feature is additive and MUST NOT remove or repurpose it.
- **FR-034-5**: This feature MUST NOT introduce a schema migration, change roster membership, or change identity resolution.
- **FR-034-6**: The change MUST be applied in lockstep across the OpenAPI contract (`pos-operators.openapi.yaml` `PosRosterCashierEntry`), the DTO (`dto.ts`), and the service mapper (`findCashiersByStore`), so the wire, type, and runtime value agree.

### Non-Goals / Out of Scope

- **N-034-1**: The POS-019 provisioning consumer + POS-017 re-anchor (POS-Pulse changes; this feature only delivers the field).
- **N-034-2**: Provisioning or backfilling `external_identity_links` (029-deferred). The roster surfaces `users.id`, which exists independent of the link table.
- **N-034-3**: Any change to roster membership rules (`store_staff` role, store-access scoping).
- **N-034-4**: Removing `clerk_user_id` / retiring the bridge (a later, separate decision).
- **N-034-5**: Surfacing `user_id` on any other POS-facing object beyond `PosRosterCashierEntry` (033 already did `PosOperatorSummary`).

### Key Entities

- **`PosRosterCashierEntry` (response object)**: the POS-facing cashier roster entry. Gains `user_id` (provider-neutral, `users.id`); retains `id` (Clerk subject, v1 bridge), `display_name`, `role`.
- **`users.id`**: the provider-neutral identity key; already the `u.id` joined in `findCashiersByStore`.

---

## Success Criteria *(mandatory)*

- **SC-034-1**: A roster entry carries `user_id == users.id` (verified by test against a seeded cashier), distinct from `clerk_user_id`.
- **SC-034-2**: `user_id` is present and non-null on every entry of a multi-cashier roster.
- **SC-034-3**: The change is additive at the application level and backward-compatible for lenient consumers; for strict consumers the contract-pin bump + POS-Pulse pin update ship as a coordinated pair. No code-behavior break either way.
- **SC-034-4**: No schema migration is introduced; no roster-membership change; no resolution-path change.
- **SC-034-5**: POS-019's cashier-`user_id`-delivery dependency is satisfied — the neutral key now reaches the terminal as readable roster data, so POS-019 provisioning stops returning `not_ready` once POS widens its roster allowlist. POS-017 Step 1 is satisfied.

---

## Gate posture *(for the future implementation dispatch — not cleared here)*

- **G10** (Identity & Access Boundary): CONSUMED. `user_id` is identity data (not a credential, not a scope-bearing token), surfaced on the roster the terminal already receives — no scope-interchange; producer-exclusion respected. Re-verify at implementation dispatch. (Same posture 033 took.)
- **G2** (Contract): extends the existing `pos-operators.openapi.yaml` POS-facing contract with an additive field (backward-compatible). Both-sides confirmation: the POS-019 consumer need (merged) is the cross-side requirement.

---

*Next: `/speckit-clarify` (likely light — auto-resolved from the 033 precedent) → `/speckit-plan`. This spec is the cashier-roster sibling of 033; the implementation is the ~4-line additive surfacing verified in the evidence basis.*
