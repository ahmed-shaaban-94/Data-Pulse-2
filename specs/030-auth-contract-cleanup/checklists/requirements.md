# Requirements Checklist — Draft D4 DP-2 Auth Contract Cleanup (Role-Named Security Schemes, additive)

> **SHIPPED — MERGED to `main` 2026-06-12** (PR #551 `33515a6`). This artifact is the as-built record; the original SPECIFY/DRAFT framing is superseded.

**Purpose:** Validate that the D4 draft is scoped to the *additive* cleanup, evidence-grounded against DP-2 `origin/main`, correctly fences out the D1 sale-sync rename, and is free of forbidden side effects.
**Created:** 2026-06-11
**Spec:** [../spec.md](../spec.md)
**Mode:** SPECIFY-ONLY / DRAFT (Orchestrator docs-only).

> A checked box means the draft text already satisfies the item, citing the section that satisfies it. Gate/owner-dependent items are flagged.

## Scope & framing

- [x] **Realizes the right 028 surface** — 028 §19 DOC-1/DOC-2/DOC-4 + DP-2 028 PI-1/DOC-2 (additive scheme cleanup), not the whole boundary. *(spec Relation-to-028; §1; E-5.)*
- [x] **Additive-only scope** — only the doc↔runtime-honest renames are in scope; behavior/guards/tokens untouched. *(§2 G-6; §3 N-3; §6.)*
- [x] **Sale-sync rename fenced OUT** — `sales.yaml` capture/void/refund stays on `clerkJwt`/Option-Y; rename deferred to D1. *(§3 N-2; §4 table; Clarifications Q2; Dependencies.)*
- [x] **Scope clearly bounded** — explicit in/out per-surface table with a stated per-surface test. *(§4; Non-goals N-1…N-8.)*

## Requirement quality

- [x] **No implementation masquerading as requirements** — contract shape described at spec altitude; no YAML authored; runtime details appear only as E-1…E-5 evidence. *(§5 note "no YAML authored"; Evidence basis.)*
- [x] **Requirements are testable** — A-1…A-10 each individually checkable (scheme defined / key retired / read-down=device / sign-in=operator-identity / service distinct / doc↔runtime-honest / sale-sync deferred / no-G3 / scopes distinct / nothing claimed done). *(Acceptance criteria.)*
- [x] **Dependencies & assumptions identified** — evidence table pins each repo HEAD; the D1→D4 REFUTED edge and the single carved-out D1 coupling are stated. *(Evidence basis; Dependencies & sequencing.)*

## Journeys / surfaces covered

- [x] **Device surface** — read-down (and other device reads) → `device` scheme, opaque token, no `bearerFormat: JWT`. *(§4 table; §5 `device`; A-3; E-2.)*
- [x] **Operator-identity surface** — sign-in → `operator-identity` provider-identity scheme as identity proof, not business authorization. *(§4 table; §5 `operator-identity`; A-4; E-4.)*
- [x] **Service surface** — connector/erpnext surfaces verified **already role-named** (`connectorBearer` machine, `cookieAuth` human session) with **no active `clerkJwt`**; **no `service` rename in D4**. *(§4 table; §5 `service` vocabulary-only; A-5; E-6.)*
- [x] **Deferred surface** — sale-sync explicitly carried as out-of-scope/Option-Y with a documented handoff to D1. *(§4 table; §6 sale-sync handoff; A-7.)*

## Security boundaries

- [x] **Scope non-interchangeability preserved** — device ≠ operator-identity ≠ service shown as distinct named schemes (028 SR-10). *(§2 G-8; §5; A-9.)*
- [x] **Provider-name de-coupling** — scheme keys describe roles, not the provider; Clerk named only in prose as current implementation. *(§5 `operator-identity` note; §2 G-1/G-2; E-5 PI-1.)*
- [x] **No credential/token-format change** — no guard, verifier, JWKS, or attestation mechanism altered. *(§3 N-3; §6 "no runtime coupling".)*
- [x] **Connector service auth left untouched and already correct** — `connectorBearer` (machine, service-to-service only) and `cookieAuth` (human session) already enforce role separation (028 §15 CM-5 / DOC-6); D4 does not rename them. *(§5 `service` vocabulary-only; A-5; E-6.)*

## Evidence discipline (SC-09)

- [x] **Current runtime evidence cited to concrete files on `origin/main`** — `clerkJwt` string in 16 files but active `security:` on 7 POS contracts only (E-1); read-down device-token mislabel + the in-file deferred-rename comment (E-2, `catalog/read-down.yaml`); sale-sync genuine Clerk JWT (E-3, `pos-sales/sales.yaml`); sign-in provider JWT (E-4, `pos-operators.openapi.yaml`); PI-1/DOC-2 in DP-2 028 spec #544/`0c57fed` (E-5); connector/erpnext already role-named `connectorBearer`/`cookieAuth`, no active `clerkJwt` (E-6, `connector-admin`/`posting-feed`/`stock-view`/`reconciliation`/`console-sync-ops`). *(Evidence basis.)*
- [x] **Pinned to the substantive HEAD** — DP-2 `0c57fed` (#544), with the `6588e86` badge tip noted. *(Evidence basis table.)*
- [x] **No unverified status claimed as fact** — "no role-named scheme exists on `origin/main`" stated; target labeled target, not done. *(E-5; A-10; §3 N-8.)*
- [x] **Drift recorded as E-n facts, not target** — the mislabel is current runtime (E-1/E-2), the role-named schemes are target (§5). Kept distinct.

## Gating & DAG compliance

- [x] **G10 listed and item labeled gated** — "gated — requires owner approval + G10 verification before any dispatch." *(authoring notes; Dependencies.)*
- [x] **Correct gate set** — G10 + G2 (contract); **G3 explicitly excluded** (no migration). *(Clarifications Q5; §3 N-4; A-8; Dependencies.)*
- [x] **D1→D4 REFUTED recorded** — startable now, parallel to the DP-2 spine; only the carved-out sale-sync rename couples to D1. *(Dependencies; drift-map citation.)*
- [x] **No dependency on D3** — D4 renames schemes; it does not build the provider-neutral identity link. *(§3 N-5; Dependencies.)*
- [x] **Open 028 OQs not auto-decided** — OQ-2/3/4/9/11 noted out-of-scope (don't bear on naming), not resolved. *(Open questions.)*

## Forbidden-files / process compliance

- [x] **No forbidden files edited** — only the spec artifacts now placed at `specs/030-auth-contract-cleanup/` (spec.md, this checklist, plan.md, tasks.md) were created (originally authored as the Orchestrator draft `d4-dp2-auth-contract-cleanup`). No application code, migrations, OpenAPI YAML, package/lock, CI, generated, secrets, env, or deployment file created or edited. No README or CLAUDE.md touched.
- [x] **Sibling repos read-only** — DP-2/POS/Console/Connector accessed only via `git show origin/main:` and `ls-tree`/`log`; no checkout/pull/merge/reset/stash; working trees not read.
- [x] **No git side effects** — nothing staged, committed, pushed, or PR'd; no `git add -A`/`git add .`; no branch switch (authored manually — no `.specify/` tooling exists here).
- [x] **No secrets** — no raw tokens/keys/passwords in any output; credential *names* and *shapes* only.

## Notes / residual items (owner-facing, not blockers)

- **Plan-phase per-operation runtime confirmation** — the "verify in plan phase" surfaces (`pos-audit-events`, `pos-shifts`, `pos-terminal-pairing`, `vouchers`, catalog reads beyond read-down) must have their actual runtime credential confirmed per operation before a role-named scheme is assigned (G-6); any that carry the sale-sync envelope are pushed to D1. *(spec §4 note; D4-OQ-2.)*
- **Scheme key spelling** — final spelling is a plan-phase naming detail, not a boundary decision. *(spec §5; D4-OQ-1.)*
- **Not yet a kernel Queue Item** — adding a kernel node / queue-routing rule for D4 is a separate Orchestrator follow-up on owner approval, not part of this draft. *(spec authoring notes.)*
