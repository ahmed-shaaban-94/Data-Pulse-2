# Tasks — Draft D4 DP-2 Auth Contract Cleanup (Role-Named Security Schemes, additive)

> **SHIPPED — MERGED to `main` 2026-06-12** (PR #551 `33515a6`). This artifact is the as-built record; the original SPECIFY/DRAFT framing is superseded.

**Status:** SPECIFY-ONLY / DRAFT — for owner review.  **Date:** 2026-06-11.  **Owning repo:** Data-Pulse-2.  **Deciders:** Owner (Ahmed Shaaban).
**Spec:** [./spec.md](./spec.md)  ·  **Plan:** [./plan.md](./plan.md)  ·  **Drift item:** D4.

> **No code, YAML, or migration is authored here.** This is an ordered task list for the OWNING repo (Data-Pulse-2) to execute POST-dispatch, after **G10 verification + scoped owner approval**. Gate legend: **[G10]** Identity & Access Boundary · **[G2]** contract. **No [G3]** appears — a security-scheme rename carries no DB migration; if a task ever needs G3, the classification is wrong.

---

## Gate / dependency preconditions

- **[G10] [G2]** Owner re-confirms G10 satisfied + grants scoped D4 approval. D4 is `[GATED]`; it does not auto-start.
- **DAG:** D1→D4 **REFUTED** (drift map) — D4 is startable now, parallel to the DP-2 spine (D3 → D1+D2 → D5+D7). The **only** D1 coupling is the carved-out sale-sync rename (T7 keeps it OUT). No dependency on D3.

## Task list (ordered)

- **T1 — Enumerate every `clerkJwt` reference.** [G10] List all operations referencing the `clerkJwt` scheme across the 16 contracts (spec E-1). Dep: preconditions. Output: operation inventory. *No code authored here.*

- **T2 — Confirm per-operation runtime credential.** [G10] For each operation in T1, trace the wired guard/verifier and record the credential it verifies today: device token / provider-identity JWT / service bearer / sale-sync Option-Y. Dep: T1. This is the additive guarantee (spec G-6); ambiguity ⇒ default DEFER. *No code authored here.*

- **T3 — Classify each operation.** [G10] Map each operation to `→ device` / `→ operator-identity` / **`DEFER to D1`**. Confirmed anchors (E-1/E-6): read-down + unknown-items + pos-audit-events → device (E-2; audit's device-attestation is the authoritative gate); pos-operators sign-in/out + pos-shifts + non-sale voucher ops → operator-identity (E-4); `sales.yaml` capture/void/refund/readSale → DEFER (E-3, drift D2). The connector/erpnext surfaces have **no active `clerkJwt`** (they use `connectorBearer` / `cookieAuth`, E-6) — they are **not** in the classification set; there is **no `service` rename**. Dep: T2. Output: classification table. *No code authored here.*

- **T4 — Define `device` scheme + re-point read-down.** [G2] [G10] Introduce the `device` securityScheme (http bearer, **no `bearerFormat: JWT`**, description = opaque device token, device-scoped, never proves sale ownership alone — 028 §6 CM-2) and re-point `catalog/read-down.yaml`'s two operations from `clerkJwt` to `device`. Highest-signal lowest-risk first (the contract already documents the device reality, E-2). Dep: T3. *No code authored here.*

- **T5 — Re-point remaining device surfaces.** [G2] [G10] Apply the `device` scheme to the other surfaces classified `→ device` in T3 (`catalog/unknown-items.yaml`, `pos-audit-events.openapi.yaml`, plus any of `pos-terminal-pairing` confirmed device-scoped). Dep: T4. *No code authored here.*

- **T6 — Define `operator-identity` scheme + re-point operator-identity surfaces.** [G2] [G10] Introduce the `operator-identity` securityScheme (http bearer, `bearerFormat: JWT`, description = identity proof / sign-in evidence only, NOT business authorization — 028 §6 CM-1; provider named only in prose) and re-point `pos-operators.openapi.yaml` sign-in/sign-out, `pos-shifts.openapi.yaml`, and the non-sale `pos-payments/vouchers.yaml` operations confirmed operator-identity in T3. Dep: T3. Parallel to T4/T5. *No code authored here.*

- **T7 — Hold sale-sync on `clerkJwt` (deferral guard).** [G2] [G10] **Do NOT rename** `pos-sales/sales.yaml` capture/void/refund/readSale. Add a description note: *rename co-delivers with the operator-authorization-envelope work (D1 / 028 DOC-3); documented faithfully as Option-Y today.* This task's success is a **negative** — sale-sync security is unchanged. Dep: T3. (Tripwire: any edit to sale-sync `security:` ⇒ scope leaked into D1 ⇒ stop.) *No code authored here.*

- **T8 — Confirm connector/service surfaces need NO rename (negative).** [G2] [G10] Verify the connector/erpnext surfaces carry **no active `clerkJwt`** and are already role-named on `origin/main` (E-6): `connectorBearer` (machine) on `erpnext-connector/{posting-feed,stock-view}.yaml`; `cookieAuth` (`dp2_session`, human session) on `connector/connector-admin.yaml`, `erpnext-reconciliation/reconciliation.yaml`, `erpnext-sync-ops/console-sync-ops.yaml`. **No `service` scheme is introduced and no rename is made.** This task's success is a **negative** — these contracts are untouched. Dep: T3. (Tripwire: any `clerkJwt`→`service` edit here means the classification was wrong ⇒ stop.) *No code authored here.*

- **T9 — Retire `clerkJwt` from fully-migrated contracts.** [G2] [G10] Remove the `clerkJwt` securityScheme definition from any POS contract whose every active reference is re-pointed (T4–T6). **Retain** `clerkJwt` on `sales.yaml` (and any surface still carrying the sale-sync envelope) until D1 completes DOC-3. Connector/erpnext contracts are untouched (T8). Dep: T4–T8. *No code authored here.*

- **T10 — Validate contracts.** [G2] Lint/validate every edited OpenAPI doc: schema validity; no `security:` entry references a removed scheme; `device` has no `bearerFormat: JWT`; `operator-identity` is identity-proof-only. (No `service` scheme is created; `connectorBearer` / `cookieAuth` are unchanged.) Dep: T9. *No code authored here.*

- **T11 — Deferral + no-migration negative tests.** [G2] [G10] Assert (a) `sales.yaml` sale-sync operations still reference `clerkJwt` and carry the D1 handoff note (T7 negative test); (b) the full diff touches only `securitySchemes` / `security:` / `description:` — no migration file, no guard/verifier source (no-G3 assertion). Dep: T10. *No code authored here.*

- **T12 — Record consumer-handoff.** [G2] Note that POS-Pulse / Console / Connector regenerate their generated clients against the renamed schemes in their own slices (028 §20); record the residual-`clerkJwt`-on-`sales.yaml` handoff to D1. Dep: T11. *No code authored here.*

## Dependency notes

- **T4/T5 (device) and T6 (operator-identity) are parallelizable** once T3 is done (independent scheme families). T8 is a confirmatory negative (no rename) and runs alongside.
- **T7 runs alongside** but is a hold/no-op guard, not an edit; it gates the scope fence.
- **T9 depends on all re-point tasks** (T4–T8) so retirement only happens on fully-migrated contracts.
- **T10–T12 are sequential validation/handoff** after the edits.

## Scope-leak tripwires (stop and return to Orchestrator for re-gating)

- Any task needs to edit a **guard / verifier / migration** → out of D4 (contract-only).
- Any task renames **sale-sync security** on `sales.yaml` → that is D1, not D4 (T7 violated).
- Any proposed **DB migration** → classification wrong; D4 has no G3.
- Any proposed **rename documenting a credential the runtime doesn't verify** → DOC-3 violation; reclassify as DEFER-to-D1.

## Out of scope

Sale-sync rename (D1 / DOC-3) · provider-neutral identity link + `IdentityProviderPort` (D3) · POS/Console/Connector client edits · any guard/token/verification change · any DB migration · any kernel/gate mutation in the Orchestrator.
