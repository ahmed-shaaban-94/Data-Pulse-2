# Requirements Checklist — Draft D3 DP-2 Provider-Neutral Identity Link & IdentityProviderPort

> **DRAFT — NOT DISPATCHED.** Planning artifact under docs-only Orchestrator. No implementation, no contract, no migration, no gate mutation. Requires explicit scoped owner approval + G10 verification before any sibling-repo dispatch.

**Purpose:** Validate that the D3 draft is scoped to the identity-link foundation only, evidence-grounded on `origin/main`, gate-correct (G10 + G3, no G2), and free of forbidden side effects before it is used to plan any Data-Pulse-2 implementation.
**Created:** 2026-06-11
**Spec:** [../spec.md](../spec.md)
**Mode:** SPECIFY-ONLY / DRAFT (Orchestrator docs-only).

> A checked box means the draft text already satisfies the item. Each item cites the spec section that satisfies it. Items dependent on an owner decision are flagged and point at the relevant clarification/open question.

## Scope & framing

- [x] **Scope is the D3 foundation only** — the identity link + `IdentityProviderPort` + resolution re-anchor + `clerk_user_id` reclassification; nothing else. *(§1; §2 G-1…G-6; §5–§8.)*
- [x] **Sibling drift explicitly excluded** — D1/D2 (envelope), D4 (contract rename), D6 (POS PIN), D8 (Console authn) named as out of scope. *(§3 N-2…N-5; §Dependencies.)*
- [x] **Boundary is consumed, not re-specified** — 028 §16 and DP-2 §13/PI-1/PI-3 are inputs; D3 is the downstream implementation slice under them. *(Relation to 028; §4 boundary-inputs table.)*
- [x] **Target vs current vs open kept distinct** — E-1/E-2/E-3 are current runtime; §5–§8 are target; clarifications/§OQ are decisions. *(Evidence basis; §5–§8; Clarifications.)*

## Requirement quality

- [x] **No implementation masquerading as requirements** — schema/port detail appears as *current evidence* (E-1/E-2/E-3) or *spec-altitude seam* (§5/§6), never as code; plan-phase mechanics deferred to plan.md/tasks.md. *(Evidence basis; §5 note; §6.)*
- [x] **Requirements are testable** — A-1…A-10 are individually checkable (link exists with named fields; resolver joins the link; `clerk_user_id` off the join path; backfill idempotent/reversible/fail-closed). *(Acceptance criteria.)*
- [x] **Dependencies & assumptions identified** — evidence table pins each repo's `origin/main` HEAD; DAG edges (D3→D8, D3→D6) and their verified caveats recorded. *(Evidence basis; §Dependencies.)*

## Journeys covered

- [x] **Resolution journey** — verify token → provider-neutral subject → join link → membership/store/eligibility unchanged. *(§7.)*
- [x] **Backfill journey** — existing `clerk_user_id` → active `clerk` link; unmappable rows fail closed and are surfaced. *(§5; §8; G-6.)*
- [x] **Lifecycle seam journey** — create/invite `linkExternalIdentity`, disable/restore `disableIdentity`/`enableIdentity` defined as seams D3 owns, consumed downstream. *(§6; §8.)*
- [x] **Provider-readiness journey** — future switch is a per-adapter change; single active link in v1, schema permits future dual-link. *(§5; §6; §2 G-5; D3-LOCAL clarification.)*

## Security boundaries

- [x] **Trust-boundary verification provider-neutralized** — `verifyIdentityToken` replaces the direct `ClerkVerifier`/`verifyToken` call (PI-3); `@clerk/backend` stays contained behind the adapter. *(§6; A-4; E-3.)*
- [x] **Fail-closed preserved** — unmappable subject fails closed (mig `0001` ADR D4 stance), never silently dropped. *(§5; §8; G-6.)*
- [x] **Credential scopes untouched** — D3 changes identity resolution only; the operator/sale-sync credential (Option-Y / `pos_operator` envelope) is explicitly out of scope. *(§3 N-2; §7; §8.)*
- [x] **No secret values in the draft** — no raw tokens, keys, passwords, or `CLERK_SECRET_KEY` value reproduced; only structural references. *(whole document.)*

## Provider independence

- [x] **Provider independence explicit** — `IdentityProviderPort` + neutral mapping; `clerk_user_id` and Clerk verification classified as v1 bridge. *(§5; §6; A-5; E-1/E-3.)*
- [x] **Migration must not require rewriting POS/Console/sale-sync business rules** — readiness-only; no second provider in v1. *(§2 G-5; §3 N-6; OQ-7.)*

## Evidence discipline

- [x] **Current runtime reflected without assuming unverified work** — E-1 (`0001` migration `clerk_user_id` + partial UNIQUE), E-2 (`findUserByClerkSubject` `WHERE clerk_user_id = $1`), E-3 (`clerk-verifier.ts` → `packages/auth` `verifyToken` re-export of `@clerk/backend`) all cite exact file paths read on DP-2 `origin/main` `0c57fed`/`6588e86`. *(Evidence basis.)*
- [x] **No unverified status claimed as fact** — D3 is labeled a DRAFT/target; the link/port absence is recorded as drift, never as done; HEADs/PRs cited (#544, #379, #33, #27). *(Evidence basis; banner; status line.)*
- [x] **E-3 precision** — does not assert `clerk-verifier.ts` calls `@clerk/backend` directly; cites the `packages/auth/src/clerk-jwt.ts` re-export as the real call site. *(E-3.)*

## Gate discipline

- [x] **G10 listed and the draft labeled gated** — "gated — requires owner approval + G10 verification before any dispatch" on the spec and every file's banner. *(Gate posture; banner.)*
- [x] **G3 carried for the schema seam** — link-table create + backfill flagged as a Migration-Gate concern (idempotent, reversible, reviewed). *(Gate posture; §5; A-6.)*
- [x] **No G2 — justified** — D3 introduces no OpenAPI/contract change; the `clerkJwt` rename is deferred to D4 (additive, refuted off D1 in the DAG). The absence of G2 is stated and reasoned, not omitted. *(Gate posture; §3 N-3.)*
- [x] **Producer-vs-consumer correct** — D3 *consumes* G10 (does not produce it); 028 is the G10 producer. *(Relation to 028; §4.)*

## Forbidden-files / process compliance

- [x] **No forbidden files edited** — only the spec artifacts now placed at `specs/029-dp2-provider-neutral-identity-link/` were created (originally authored as the Orchestrator draft `d3-dp2-identity-link`). No `apps/**`, `packages/**`, migrations, OpenAPI YAML, package/lock, CI, generated, secrets, env, deployment in any repo. No README/CLAUDE.md touched.
- [x] **No sibling-repo edit** — Data-Pulse-2, POS-Pulse, Console, Connector were read **read-only** via `git -C … show origin/main:…` / `ls-tree` / `log`; never checked out, pulled, or written. (SC-04/SC-05 honored.)
- [x] **No existing Orchestrator file edited** — `docs/gates/**`, `docs/kernel/**`, `docs/status/**`, the 028/029 specs, README, CLAUDE.md are unmodified; D3 only creates new files in its own draft folder.
- [x] **No git side effects** — nothing staged, committed, pushed, or PR'd; no `git add -A`/`git add .`; no branch switch. Authored manually (no `.specify/` tooling in the Orchestrator).
- [x] **No kernel/gate/status mutation** — D3 does not advance the queue, add a `graph.yml` node, or update `cross-repo-status.md`; it feeds a future Queue Item under G10 on owner approval. *(§3 N-8; authoring notes.)*

## Notes / residual items (owner-facing, not blockers)

- **D3 is the DAG foundation** — startable first once G10 is verified; D8 and D6 key off it (D6 also needs D1/D5; D8 also needs the Console `62d0906` re-pin). *(§Dependencies.)*
- **The drift (E-1/E-2/E-3) is recorded as content, not resolved** — resolving it is the owner-gated D3 dispatch to Data-Pulse-2 (plan.md/tasks.md describe the post-dispatch approach).
- **OQ-2/3/4/9/11 are carried, not auto-decided** — confirmed out of D3 scope (PIN / multi-terminal / refresh / break-glass). *(§Open questions.)*
