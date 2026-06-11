# Requirements Checklist — Draft D1+D2 DP-2 Operator-Authorization Envelope (mint & return at sign-in)

> **DRAFT — NOT DISPATCHED.** Planning artifact under docs-only Orchestrator. No implementation, no contract, no migration, no gate mutation. Requires explicit scoped owner approval + G10 verification before any sibling-repo dispatch.

**Purpose:** Validate that this DRAFT follow-up spec is boundary-conformant (consumes 028 / G10, does not re-specify it), evidence-grounded on `origin/main`, correctly scoped to D1+D2 (no creep into D3/D5/D6/D7), and free of forbidden side effects — before it is used to plan any DP-2 implementation.
**Created:** 2026-06-11
**Spec:** [../spec.md](../spec.md)
**Mode:** SPECIFY+CLARIFY-only (Orchestrator docs-only; GATED item — no `plan.md`/`tasks.md`).

> A checked box means the draft text already satisfies the item; each cites the spec section that satisfies it. Owner-decision-dependent items point at the relevant Open Question.

## Scope & framing

- [x] **Correctly scoped as a downstream follow-up, not a re-spec of 028** — the draft consumes G10 and conforms to 028 §9/§6/§17, and says so. *(Relation to 028; Dependencies & sequencing.)*
- [x] **D1 and D2 framed as one slice** — issuance (return the envelope) and use (re-wire the guard) close the phantom together. *(Clarifications Q4; §1; A-2/A-3.)*
- [x] **Scope fenced against D3** — no change to the `clerk_user_id` resolution join; "provider-neutral" = the client credential, not the resolution path. *(authoring note 4; N-2; E-4; A-6.)*
- [x] **Scope fenced against D5/D6/D7** — no POS-Pulse, offline-PIN, or device-token-role change. *(N-3/N-4; Clarifications Q6.)*
- [x] **GATED-item discipline** — labeled "gated — requires owner approval + G10 verification before any dispatch"; SPECIFY+CLARIFY only; no plan/tasks authored. *(Status line; authoring note 3; footer.)*

## Requirement quality

- [x] **No implementation masquerading as requirements** — current code (E-1/E-2/E-3/E-4) is labeled *current-runtime evidence*; the envelope is described as a seam at spec altitude, explicitly "NOT a wire contract." *(Evidence basis; §5 preamble.)*
- [x] **Requirements are testable** — goals G-1…G-7 and acceptance criteria A-1…A-9 are individually checkable against route↔guard wiring and the sign-in response shape. *(§2; §7.)*
- [x] **Dependencies & assumptions identified** — evidence table pins each repo's `origin/main` HEAD; the DAG section separates the hard G10 gate from recommended D3-first sequencing. *(Evidence basis; Dependencies & sequencing.)*
- [x] **The "return + re-wire, not build" framing is explicit** — the `auth_tokens` row, scope binding, TTL, and sign-out revocation already exist; the delta is return + re-point. *(§1; §4 table; §5 last bullet.)*

## Journeys covered

- [x] **Operator sign-in issuance** — envelope minted and returned at sign-in and takeover-confirm. *(§6 sign-in/takeover rows; A-1.)*
- [x] **Sale-write use** — capture/void/refund re-wired onto the canonical `pos_operator` path; composed predicate preserved. *(§6 sale rows; A-3/A-4.)*
- [x] **Phantom-guard closure** — the returned envelope satisfies the canonical `PosOperatorAuthGuard` on `readSale`. *(E-3; §6 readSale row; A-2.)*
- [x] **Revocation / sign-out** — existing `auth_tokens` revoke path preserved. *(§5 lifecycle; §6 sign-out row.)*

## Security boundaries

- [x] **Authn vs authz separation preserved** — provider JWT = identity proof at sign-in only; the DP-2-issued envelope = authorization. *(§5 provider-neutrality bullet; Clarifications Q1; 028 §6 CM-1/CM-3.)*
- [x] **Scope non-interchangeability preserved** — envelope is `pos_operator`-scoped and not valid on read-down/dashboard/service/admin surfaces. *(§5 scope bullet; 028 SR-10.)*
- [x] **Composed predicate not weakened** — identity + device trust + tenant/store + eligibility + expiry must all still hold; device-only / JWT-only still refused. *(G-4; A-4; 028 §18 refusal rows.)*
- [x] **Provenance & audit preserved** — real `actor_user_id` and resolved scope still on `sale.captured/voided/refunded`. *(G-5; A-5.)*
- [x] **Non-disclosing failure posture preserved** — all refusals collapse to a generic 401; no enumeration. *(G-7; A-7; 028 SR-6.)*
- [x] **No secrets / tokens in this draft or in logs (target)** — no raw token/hash value reproduced; SR-2 carried as a target constraint. *(A-7; N-1; no secret printed anywhere in the draft.)*

## Provider independence

- [x] **Client-presentable credential is provider-neutral** — carries no Clerk-specific field; verifiable without the provider. *(G-6; §5; A-6; 028 §16.)*
- [x] **Provider-neutrality scoped to the credential, not the resolution join** — D3 (the identity link) is explicitly out of scope and not a hard gate on D1. *(N-2; Clarifications Q5; Dependencies & sequencing.)*

## Evidence discipline (SC-09 / runtime caution)

- [x] **Evidence cites the HEAD actually read** — DP-2 `6588e86` (badge) / `0c57fed` (substantive #544), not 028's stale `957b7c9`. *(Evidence basis table.)*
- [x] **Every drift fact cites a concrete file / route / column** — E-1 (`sales.controller.ts` lines 77/149/200 + `pos-operator-sale-auth.guard.ts`), E-2 (`pos-operators.service.ts` `issueOperatorSessionRow` INSERT + `dto.ts` `PosOperatorSessionSummaryBody` + `pos-operator-auth.guard.ts` + `readSale` line 113), E-3 (canonical guard scope check), E-4 (`WHERE clerk_user_id = $1`). *(Evidence basis E-1…E-4.)*
- [x] **No unverified status claimed as fact** — the reconciliation is "owner-ratified in direction (OQ-8), not implemented"; drift facts are recorded on `origin/main`, never as the target. *(Evidence basis SC-09 note; §1.)*
- [x] **Plan-phase sub-questions NOT auto-decided** — envelope format / TTL / refresh / multi-terminal / transport carried as OQ-1…OQ-5; "return the discarded raw token" is explicitly NOT prescribed. *(N-5; A-8; §8 OQ-1; spec authoring note 3.)*

## Gate compliance

- [x] **G10 listed as a hard gate** — the item is auth/identity/access-touching and lists G10; dispatch requires owner approval + G10 verification; 028 (producer) is signed. *(Status line; Dependencies & sequencing.)*
- [x] **Producer/consumer respected** — 028 is the G10 producer and is NOT re-specified; this draft is a consumer. *(Relation to 028; Dependencies & sequencing.)*
- [x] **Residual 028 OQs noted as non-blocking** — OQ-2/3/4/9/11 do not gate this slice. *(§8 referenced-028-open note; Dependencies & sequencing.)*

## Forbidden-files / process compliance

- [x] **Wrote only inside the assigned draft folder** — `docs/specs/drafts/028-followups/d1-2-dp2-operator-envelope/spec.md` and this checklist. No file outside the draft folder. *(This authoring session.)*
- [x] **No sibling-repo edit** — Data-Pulse-2 / POS-Pulse / Console / Connector read **read-only** via `git -C … show origin/main:…` and `ls-tree` / `grep` against `origin/main`; no working-tree read, no checkout/pull/merge/reset/stash. No `apps/**`, `packages/**`, migration, OpenAPI YAML, contract, package/lock, CI, generated, secret, env, or deployment file touched in any repo. *(SC-04/SC-05 respected.)*
- [x] **No existing Orchestrator file edited** — `docs/gates/**`, `docs/kernel/**`, `docs/status/**`, the 028/029 specs, README, and CLAUDE.md were read only; no edit. Only new files created in the draft folder. *(This authoring session.)*
- [x] **No git side effects** — nothing staged, committed, pushed, or PR'd; no `git add -A`/`git add .`; no branch switch. Authored manually (no `.specify/` tooling exists here). *(This authoring session.)*
- [x] **No gate / kernel / status mutation** — no gate added, no kernel node, no Queue ID, no status change; this draft only *feeds* a future Queue Item under G10. *(authoring note 3; spec footer.)*
- [x] **Every file opens with the exact DRAFT-NOT-DISPATCHED banner.** *(spec.md line 3; this file line 3.)*

## Notes / residual items (owner-facing, not blockers)

- **The drift (E-1/E-2) is recorded as content, not resolved** — resolving it is owner-gated (028 OQ-8 direction) and this very DP-2 follow-up under G10. No plan/tasks here (GATED).
- **D3-first is recommended sequencing, not a gate** — the owner may sequence D3 ahead, but D1's only hard dependency is G10 + approval (the DAG refuted a hard D3→D1 edge).
- **DOC-3 sale-route rename co-travels with this slice**; the broader DOC-1/2/4 cleanup is the separate, parallelizable drift D4.
- **This draft is not a kernel Queue Item** — promoting it to a node in `docs/kernel/graph.yml` + a queue routing rule is a separate Orchestrator follow-up, on owner approval, outside this SPECIFY+CLARIFY task.
