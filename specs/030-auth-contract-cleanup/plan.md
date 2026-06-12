# Plan — Draft D4 DP-2 Auth Contract Cleanup (Role-Named Security Schemes, additive)

> **SHIPPED — MERGED to `main` 2026-06-12** (PR #551 `33515a6`). This artifact is the as-built record; the original SPECIFY/DRAFT framing is superseded.

**Status:** SPECIFY-ONLY / DRAFT — for owner review.  **Date:** 2026-06-11.  **Owning repo:** Data-Pulse-2.  **Deciders:** Owner (Ahmed Shaaban).
**Spec:** [./spec.md](./spec.md)  ·  **Drift item:** D4 (`docs/roadmap/auth-028-drift-map.md`).

> **This plan is for the OWNING repo (Data-Pulse-2) to execute POST-dispatch.** It is architecture-altitude only. **No code, no YAML, no migration is authored here.** Dispatch is gated: **G10 verification + scoped owner approval** before any work begins in Data-Pulse-2. Gates throughout: **G10** (Identity & Access Boundary) + **G2** (contract). **No G3** — security-scheme renaming carries no DB migration.

---

## Gate preconditions (must hold before any phase starts)

- **G10 verified** — the 028 Identity & Access Boundary Gate is satisfied for boundary decisions (it is, per drift-map "G10 is satisfied-for-boundary-decisions while [OQ-2/3/4/9/11] remain open"). Owner re-confirms at dispatch.
- **G2 (contract) in force** — this is a contract change; contract-review discipline applies.
- **Scoped owner approval** for D4 specifically — D4 is `[GATED]`; it does not auto-start from the boundary being signed.
- **D1 status known** — not a blocker (D1→D4 REFUTED), but the sale-sync surfaces are carved out and must remain on `clerkJwt` until D1 lands. The plan must not race D1 on `sales.yaml`.

## Phase 0 — Per-operation runtime confirmation (the additive guarantee) [G10]

The additive guarantee (spec G-6) holds only if each renamed surface's new scheme matches the credential its guard *actually* verifies today. Before any rename:

- Enumerate every operation with an **active** `clerkJwt` `security:` reference — 7 POS contracts on `origin/main` (spec E-1/E-6); ignore the prose-disclaimer mentions in connector/erpnext files.
- For each, trace the wired guard/verifier and record the verified runtime credential: **device token**, **provider-identity JWT**, or **sale-sync Option-Y (Clerk JWT + `X-Device-Attestation`)**.
- Classify each operation into one of: `→ device`, `→ operator-identity`, or **`DEFER to D1`** (sale-sync envelope surfaces). No `→ service` bucket — connector/erpnext surfaces are already role-named and out of scope (E-6).
- Output: a per-operation mapping table. Any ambiguity ⇒ default to DEFER, never to a rename that might describe unbuilt behavior.

Confirmed anchors (from spec evidence, do not re-derive): read-down + unknown-items + pos-audit-events → `device` (E-2; audit's device-attestation is the authoritative gate); sign-in + shifts + non-sale voucher ops → `operator-identity` (E-4); `sales.yaml` capture/void/refund/readSale → **DEFER to D1** (E-3, drift D2). Connector/erpnext (`connectorBearer` / `cookieAuth`) → **not in scope, no rename** (E-6).

## Phase 1 — Introduce role-named schemes alongside `clerkJwt` (additive) [G2 contract, G10]

- Define the **two** role-named `securitySchemes` in the POS contracts that need them:
  - **`operator-identity`** — http bearer, `bearerFormat: JWT`; description = identity proof / sign-in evidence only, not business authorization (028 §6 CM-1). Provider (Clerk) named only in prose as the current implementation.
  - **`device`** — http bearer, **no `bearerFormat: JWT`**; description = opaque device pairing token, device-scoped, never proves sale ownership alone (028 §6 CM-2).
- **No `service` scheme is created** — the connector/erpnext surfaces already carry `connectorBearer` (machine) and `cookieAuth` (human session) and are out of scope (E-6; Phase 0 confirms, does not rename).
- Schemes are introduced **without yet removing** `clerkJwt` — both coexist during the cutover (no flag-day).

## Phase 2 — Re-point in-scope operations to role-named schemes [G2 contract, G10]

- For each operation classified in Phase 0 as `→ device` / `→ operator-identity`, change its `security:` reference from `clerkJwt` to the matching role-named scheme. (No `→ service` operations exist — connector/erpnext untouched, E-6.)
- **Read-down first** (the canonical mislabel, E-2) — it is the highest-signal, lowest-risk surface and the contract already documents the device-token reality.
- Update each migrated operation's description to match (e.g. read-down: "device-principal authentication; opaque device token; no operator credential").
- **Do NOT touch** sale-sync security on `sales.yaml` (capture/void/refund/readSale) — leave `clerkJwt` and add a description note: *rename co-delivers with the operator-authorization-envelope work (D1 / 028 DOC-3); documented faithfully as Option-Y today.*

## Phase 3 — Retire `clerkJwt` from fully-migrated surfaces [G2 contract, G10]

- Remove the `clerkJwt` `securityScheme` definition from any contract whose every `clerkJwt` reference has been re-pointed.
- **Retain `clerkJwt`** in `pos-sales/sales.yaml` (and any other surface still carrying the sale-sync envelope) until D1 completes DOC-3 there.
- Net result: `clerkJwt` survives only where it is still *honest* (genuine Clerk JWT on the deferred sale-sync surfaces).

## Phase 4 — Validation & consumer-handoff [G2 contract]

- **Lint/validate** the OpenAPI documents (schema validity, no dangling `security:` references to removed schemes).
- **Doc↔runtime audit** — re-confirm each renamed surface's scheme still matches the wired guard (no runtime drift introduced).
- **Consumer regeneration is downstream, not here** — POS-Pulse / Console / Connector regenerate their generated clients against the renamed schemes as part of their own slices (028 §20). This plan delivers the contracts only.
- **Sale-sync handoff note** recorded so D1 picks up the residual `clerkJwt` retirement on `sales.yaml`.

## Test / verification strategy (contract-level)

- **Contract validity** — each edited OpenAPI doc parses and validates.
- **No orphan references** — every `security:` entry resolves to a defined scheme; no operation left referencing a removed `clerkJwt`.
- **Role-honesty assertions** — `device` scheme has no `bearerFormat: JWT`; `operator-identity` is described as identity-proof-only. (No `service` scheme is created; the existing `connectorBearer` / `cookieAuth` schemes remain unchanged.)
- **Deferral assertion** — `sales.yaml` sale-sync operations still reference `clerkJwt` and carry the D1 handoff note (negative test: D4 must NOT have renamed them).
- **No-migration assertion** — diff touches only `securitySchemes` and `security:`/`description:` fields; no migration file, no guard/verifier source. (If a guard source change appears, scope has leaked → stop.)
- **Generated-client smoke (downstream repos)** — deferred to the consuming repos' slices; named here only as the handoff boundary.

## Risk / scope-leak guards

- **Scope-leak tripwire:** if any phase requires editing a guard, verifier, migration, or the sale-sync security on `sales.yaml`, the work has crossed into D1 (or out of D4 entirely) — **stop and return to the Orchestrator for re-gating.**
- **Doc-describes-unbuilt tripwire:** if a proposed rename would document a credential the runtime does not yet verify, it is a DOC-3 violation — reclassify the surface as DEFER-to-D1.
- **G3 tripwire:** if anyone proposes a DB migration for this item, the classification is wrong — D4 is contract-only.

## Out of scope (this plan)

- Sale-sync scheme rename (D1 / DOC-3); provider-neutral identity link + `IdentityProviderPort` (D3); POS/Console/Connector client edits; any guard/token/verification change; any DB migration.
