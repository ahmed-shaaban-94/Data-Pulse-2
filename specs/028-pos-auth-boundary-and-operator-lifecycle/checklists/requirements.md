# Requirements Quality Checklist — 028 POS Auth Boundary & Operator Lifecycle

**Purpose**: Validate that `spec.md` is complete, honest, well-scoped, and free of
implementation-detail leakage **as a specification** — before any planning or
build work begins. This checklist tests the **spec document**, not a running
system. SPECIFY-ONLY: no code/migration/OpenAPI is in scope.

How to read: each item is checkable against `spec.md` (section refs in
parentheses). `[x]` = satisfied by the current draft; `[ ]` = open / to confirm
with owner. Items left `[ ]` are deliberately unresolved owner decisions
(mirrored in §18 Open questions), not omissions.

---

## A. No implementation details masquerading as requirements

- [x] **A1** — Requirements describe **what/why** (authority, validity, refusal),
  not framework wiring. NestJS guard class names, SQL, and column names appear
  **only** as cited *evidence* of current state, never as the requirement itself.
  (§6/§7 evidence columns; §13 PI-1)
- [x] **A2** — Where a concrete artifact is named (e.g. `users.clerk_user_id`,
  `clerkJwt` scheme), it is explicitly classified as a **v1 legacy bridge /
  implementation detail**, not the long-term domain model. (§13 PI-1, §18 OQ-6)
- [x] **A3** — True constraints that *must* be stated concretely (e.g.
  "device token in `Authorization`", "attestation in a header not the body") are
  justified by a real correctness reason (idempotency-fingerprint integrity), not
  smuggled-in design preference. (§16 #15, §6 device row)
- [ ] **A4** — Owner confirms no remaining requirement is actually a premature
  design decision that should be deferred to plan/build. (review gate)

## B. All core user journeys covered

- [x] **B1** — Create/invite cashier in Console. (§16 #1, §8)
- [x] **B2** — First **online** login on a paired terminal. (§16 #2, §10 OFF-1)
- [x] **B3** — Offline unlock after prior online login. (§16 #3, §10)
- [x] **B4** — First-login-while-offline refusal. (§16 #4)
- [x] **B5** — Cloud password reset (provider-driven, online). (§16 #5/#7, §11)
- [x] **B6** — Local PIN reset (online re-auth; offline override path). (§16 #6, §11)
- [x] **B7** — Disable cashier (online and offline cases). (§16 #8/#9, §8)
- [x] **B8** — Remove store access while offline. (§16 #10)
- [x] **B9** — Device revoke (online and while offline). (§16 #11, §12)
- [x] **B10** — Pending offline sales with expired operator session. (§16 #12)
- [x] **B11** — Sign-in network drop; sale-sync 401; idempotent replay. (§16 #13/#14/#15)
- [x] **B12** — Same cashier on two terminals. (§16 #16)
- [x] **B13** — Provider down; provider migration. (§16 #17/#18)
- [x] **B14** — Local secret storage unavailable; copied local DB; wrong clock. (§16 #19/#20/#21)
- [x] **B15** — Shared-account creation attempt rejected. (§16 #22)

## C. Offline behaviour is bounded and auditable

- [x] **C1** — First login cannot be offline. (§10 OFF-1)
- [x] **C2** — Offline unlock uses local PIN + cached profile, never a backend
  credential call. (§10 OFF-2/3, §6 CM-4)
- [x] **C3** — PIN is settable only **after** online verification. (§10 OFF-4, §11)
- [x] **C4** — Offline access has a **bounded grace period**. (§10 OFF-5)
- [x] **C5** — Exact grace-period value chosen: **tenant-configurable, default 24h**
  within a hard ceiling (OQ-1 RESOLVED 2026-06-11, Orchestrator 028 adopted). (§18 OQ-1, § Clarifications)
- [x] **C6** — Offline sales record operator/device/store/local-timestamp
  provenance and stay in the outbox until sync. (§10 OFF-6/7, §14 SEC-9)
- [x] **C7** — On reconnect, revocation + current authorization are reconciled.
  (§10 OFF-8, §16 #9/#10/#11)
- [x] **C8** — Offline actions are audited locally and synced later. (§14 SEC-8, §11)
- [ ] **C9** — Offline manager override allowed? (§18 OQ-2)

## D. Provider independence is explicit

- [x] **D1** — A provider-neutral port (`IdentityProviderPort`) with the required
  operations is defined. (§13)
- [x] **D2** — A provider-neutral identity mapping shape is defined
  (`provider_key`/`issuer`/`subject`/`user_id`/`email`/`status`/`linked_at`). (§13)
- [x] **D3** — Clerk-specific fields/APIs are forbidden from POS business
  authorization and route contracts; current coupling is named as drift. (§13 PI-1)
- [x] **D4** — Provider migration must not require rewriting POS authorization
  rules (authorization keys off local `user_id`/membership/role/store). (§13 PI-2, §16 #18)
- [x] **D5** — Decided: v1 **introduces the neutral identity link first**;
  `clerk_user_id` is a bridge column behind it (OQ-6 RESOLVED 2026-06-11, Orchestrator 028
  adopted). (§18 OQ-6, § Clarifications)
- [x] **D6** — Decided: provider migration is **architecture-readiness only, not v1 build
  scope** (OQ-7 RESOLVED 2026-06-11, Orchestrator 028 adopted). (§18 OQ-7, § Clarifications)

## E. Security boundaries are explicit

- [x] **E1** — Credential matrix states, per credential, what it must **never**
  authorize. (§6)
- [x] **E2** — Route/surface matrix states required credential + authority +
  success + refusal per surface. (§7)
- [x] **E3** — Token scopes are non-interchangeable; cross-surface use is refused.
  (§14 SEC-10, §7 connector/dashboard/POS rows)
- [x] **E4** — Refusals are non-enumerating to clients; server may log a reason by
  request id. (§14 SEC-6/7)
- [x] **E5** — No raw passwords; no token values in logs; no long-lived raw
  provider JWT storage; no provider admin creds on POS. (§14 SEC-1/2/3/11)
- [x] **E6** — Sale facts preserve operator/device/store provenance; auth never
  rides in the sale body. (§14 SEC-9, §16 #15)
- [x] **E7** — No shared cashier accounts. (§3 NG8, §14 SEC-4)

## F. Existing runtime evidence reflected without over-claiming

- [x] **F1** — Shipped behaviour is cited from real files (guards, resolver,
  verifier, 002 FRs), not assumed. (§6/§7 evidence, Evidence-inspected appendix)
- [x] **F2** — The sale-sync **drift** (Option-Y raw Clerk JWT vs target
  `pos_operator`) is stated as drift, **not** as a satisfied requirement.
  (§6 CM-1/CM-3 drift note, §7 sale-sync row, §9, §15 DOC-3, §17 AC-13)
- [x] **F3** — The phantom `pos_operator` credential (scope guard demands a token
  sign-in never issues) is named explicitly as the clash. (§7 sale-sync row, §9
  "Issue internal session" drift)
- [x] **F4** — No unverified future work is described as done; not-yet-built
  pieces (offline unlock, local PIN, identity port) are clearly target-state.
  (§2 G-notes, §10, §13)
- [x] **F5** — Device-pairing CONSUME and returns/reversal are **referenced**, not
  re-spec'd. (§3 NG10, §12, Evidence appendix)

## G. Non-goals prevent scope creep

- [x] **G1** — Non-goals explicitly exclude: custom password DB, ERPNext cashier
  identity, POS→ERPNext auth, POS provider-admin-API use, offline cloud reset,
  device-token-only sale-sync, raw provider JWT as durable sale-sync credential,
  shared accounts, and any code/migration/OpenAPI work. (§3)
- [x] **G2** — The numbering collision with the shipped `027` is resolved (this
  feature is `028`) and the boundary to `027`/`026` is drawn, preventing
  accidental re-spec. (front-matter numbering note, §3 NG10)
- [x] **G3** — Section 15 names OpenAPI cleanup as **later, separately-gated**
  work and forbids editing any contract in this feature. (§15)

## H. Structural completeness (all required sections present)

- [x] **H1** — Summary, Goals, Non-goals, Actors present. (§1–§4)
- [x] **H2** — Authority model, Credential matrix, Route/surface matrix present.
  (§5–§7)
- [x] **H3** — User lifecycle, POS operator lifecycle, Offline behaviour present.
  (§8–§10)
- [x] **H4** — Password vs PIN reset, Device lifecycle, Provider independence
  present. (§11–§13)
- [x] **H5** — Security/audit, OpenAPI cleanup, Scenarios present. (§14–§16)
- [x] **H6** — Acceptance criteria and Open questions present. (§17–§18)

---

**Resolved 2026-06-11** (adopted from the merged cross-repo boundary, Orchestrator 028 /
PR #85): C5 (OQ-1 grace), D5 (OQ-6 identity link), D6 (OQ-7 migration scope), plus §18
OQ-5 (offline-sync authority) and OQ-8 (sale-sync credential direction). See § Clarifications.

**Outstanding owner decisions** (open `[ ]` items): A4 (review gate), C9 (§18 OQ-2 offline
manager override) — plus §18 OQ-3 (PIN policy) / OQ-4 (multi-terminal). These are
intentional plan-phase decisions and block planning, not this specification.
