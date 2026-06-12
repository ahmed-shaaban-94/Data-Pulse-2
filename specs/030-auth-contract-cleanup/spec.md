# Draft D4 — DP-2 Auth Contract Cleanup: Role-Named Security Schemes (additive)

> **SHIPPED — MERGED to `main` 2026-06-12** (PR #551 `33515a6`). This artifact is the as-built record; the original SPECIFY/DRAFT framing is superseded.

**Status:** SPECIFY-ONLY / DRAFT — for owner review.  **Date:** 2026-06-11.  **Owning repo:** Data-Pulse-2.  **Deciders:** Owner (Ahmed Shaaban).

**Relation to 028:** Realizes 028 §19 **DOC-1 / DOC-2 / DOC-4** (and the DP-2-side `028-pos-auth-boundary-and-operator-lifecycle` spec's **PI-1 / DOC-2**) — the *additive* OpenAPI security-scheme cleanup so contract scheme names describe the credential's **role** (operator-identity / device / service), not a specific provider. 028 owns the identity/access boundary this conforms to; this draft does **not** re-specify that boundary, it consumes it (gate **G10**).

> ### authoring & placement notes (owner can redirect)
>
> - **Docs-only.** This file lives under the Orchestrator's allowed `docs/**` surface as a planning draft. It implements nothing, edits no contract, mutates no gate or kernel node. It records *target* contract shape and *current* runtime evidence as separate things.
> - **No `.specify/` tooling exists in this repo**, so this was authored manually following the speckit spec structure and the house style of `docs/specs/028-project-auth-identity-access-boundary/spec.md` — not via `/speckit.specify`. The template-copy / `feature.json` / branch steps are moot here.
> - **This feeds a future Queue Item under G10**, not a kernel mutation. Adding a kernel node or queue-routing rule for this item is itself a separate Orchestrator follow-up, done on owner approval — not part of this SPECIFY-ONLY draft.
> - **Gated.** Auth/identity/access surface → **gated — requires owner approval + G10 verification before any dispatch.** Gates: **G10** (Identity & Access Boundary) + **G2** (contract). **No G3** — a security-scheme rename is contract-only; it carries no DB migration.

---

## Clarifications

### Session 2026-06-11

- Q: `clerkJwt` appears in **16** contract files — does the additive cleanup rename every occurrence now, or only the surfaces whose *current runtime* the new name keeps honest? → A: **Only the surfaces with an active `clerkJwt` `security:` reference whose rename keeps doc↔runtime honest** — which on `origin/main` is **7 POS contracts only** (E-1/E-6). Device-authenticated POS surfaces (read-down, unknown-items, pos-audit-events) → a `device` scheme (E-2); operator-identity POS surfaces (sign-in, shifts, non-sale voucher ops) → an `operator-identity` scheme (E-4). The connector/erpnext surfaces are **already** role-named (`connectorBearer` / `cookieAuth`, E-6) — their `clerkJwt` mentions are prose disclaimers, so they need **no rename** and there is **no `service` rename** in D4. Sale-sync surfaces stay on `clerkJwt`/Option-Y, NOT renamed here (deferred to D1). Rationale: the per-surface test is "does relabeling keep the doc matching today's runtime?" — yes ⇒ additive/in-scope; no (or already correct) ⇒ excluded. This is the exact discipline 028 §19 DOC-3 protects (drift-map "Why the refutations hold").
- Q: Does the sale-sync (`captureSale` / void / refund in `pos-sales/sales.yaml`) scheme rename belong in D4? → A: **No — explicitly deferred to D1** — its runtime is still a genuine Clerk JWT + `X-Device-Attestation` (E-3); renaming it to an internal-envelope/operator name now would document the *unbuilt* envelope and *create* the DOC-3 mismatch the deferral exists to prevent. D4 documents sale-sync's auth faithfully as Option-Y and carries the rename as a non-goal owned by D1. (Drift-map: **D1→D4 edge REFUTED**; the only D1 coupling is this carved-out rename.)
- Q: Does the **sign-in** surface (`pos-operators` `posOperatorSignIn`), which presents a provider JWT for identity proof, get de-Clerk-ified now or wait for D1? → A: **De-Clerk-ify now, additively** — sign-in's credential genuinely *is* a provider identity JWT (identity proof), so an `operator-identity` / provider-identity scheme name is honest against today's runtime (E-4) and independent of the sale-sync envelope. It is distinct from sale-sync's *target* operator-authorization envelope (D1) and must not be conflated with it. (028 §6: a provider JWT is identity proof, not business authorization.)
- Q: Is a new device scheme **key** introduced, or is the existing `clerkJwt` key reused with a corrected description on read-down? → A: **Introduce a distinct role-named device scheme key** (e.g. `posDeviceAuth`) and point read-down at it — the read-down contract *itself* flags renaming the key POS-wide as "a separate cross-contract decision for the owner/backend" (E-2); D4 IS that decision. A description-only fix leaves the misleading key in place (fails DOC-1's "not confusable" test). Final scheme key spelling is a plan-phase detail for the owning repo, not a boundary decision.
- Q: Does this cleanup require any migration, runtime guard change, or token-format change? → A: **No** — additive doc/contract naming only. The guards, tokens, and verification stay exactly as shipped; only OpenAPI `securitySchemes` keys/descriptions and per-operation `security:` references change. Gate tags therefore = G10 + G2 (contract), **never G3** (migration).

---

## Evidence basis (verified this session, `origin/main`, 2026-06-11)

| Repo | `origin/main` HEAD | What was read |
|---|---|---|
| Data-Pulse-2 | `0c57fed` (substantive #544; badge `6588e86` on top) | `packages/contracts/openapi/**/*.yaml` — `clerkJwt` security scheme across 16 contracts; `catalog/read-down.yaml` scheme comment + description; `pos-sales/sales.yaml` scheme; `pos-operators.openapi.yaml` scheme; `specs/028-pos-auth-boundary-and-operator-lifecycle/spec.md` PI-1/DOC-2/DOC-3 |
| POS-Pulse | `b34932b` (substantive #379; badge `0bb2ed8`) | not modified by D4; client consumes these schemes (read-only reference) |
| Retail-Tower-Console | `97a7d42` | consumer of catalog/connector contracts (read-only reference) |
| Retail-Tower-ERP-Next-Connector | `bc768ad` | consumer of connector/posting contracts (read-only reference) |
| Retail-Tower-Orchestrator | `main` (clean) | `docs/specs/028-*/spec.md` §19, `docs/roadmap/auth-028-drift-map.md` D4 row + DAG |

Current-runtime facts (kept distinct from *target* and *open decisions*):

- **E-1 (the mislabel, and its true extent).** The provider-named string `clerkJwt` appears in **16** contract files on DP-2 `origin/main`, but it is an **active operation-level `security:` reference on only 7 POS contracts** (E-6): `catalog/read-down.yaml`, `catalog/unknown-items.yaml`, `pos-audit-events.openapi.yaml`, `pos-operators.openapi.yaml`, `pos-payments/vouchers.yaml`, `pos-sales/sales.yaml` (deferred, E-3), `pos-shifts.openapi.yaml`. On the other 9 files the `clerkJwt` mentions are **prose disclaimers** in descriptions ("NOT a Clerk JWT", "NOT the POS `clerkJwt` device scheme"), not active credentials. Where active, the single key spans *device* surfaces (read-down, unknown-items, audit-events) and *operator-identity* surfaces (operators sign-in, shifts, vouchers) — DOC-1's "not confusable" failure within the POS contract family.
- **E-2 (read-down: a device token under a Clerk-named scheme — the contract admits it).** In `packages/contracts/openapi/catalog/read-down.yaml`, both operations (`security: - clerkJwt: []`) authenticate by the terminal's `devices` PAIRING TOKEN as `Authorization: Bearer <device_token>` — "an opaque token (NOT a JWT), with NO operator Clerk JWT and NO `X-Terminal-Token` header." The scheme block omits `bearerFormat: JWT` deliberately and the in-file comment states: "Renaming the scheme key POS-wide to something like `posDeviceAuth` is a separate cross-contract decision for the owner/backend, out of #488 scope." This is the smoking-gun mislabel D4/DOC-4 targets, and D4 *is* that deferred cross-contract decision.
- **E-3 (sale-sync: a genuine Clerk JWT — deferral boundary).** In `packages/contracts/openapi/pos-sales/sales.yaml`, the `clerkJwt` scheme is `type: http, scheme: bearer, bearerFormat: JWT` — "Clerk-issued JWT presented as `Authorization: Bearer <jwt>`, paired with the platform device-token header" (`X-Device-Attestation`, Option-Y) on `captureSale` / void / refund. Renaming this to an operator-envelope name now would document an unbuilt credential. Faithfully documenting Option-Y here and deferring the rename to D1 is the DOC-3 discipline.
- **E-4 (sign-in: a genuine provider-identity JWT).** In `packages/contracts/openapi/pos-operators.openapi.yaml`, `posOperatorSignIn` (`security: - clerkJwt: []`) verifies a "Clerk-issued JWT … against Clerk's JWKS (signature, `iss`, `aud`, `exp`, `nbf`, `iat`)" as identity proof at sign-in. This is provider-identity authn (028 §6: identity proof, *not* business authorization) and an `operator-identity`/provider-identity scheme name is honest against this runtime today — independent of the sale-sync envelope (D1).
- **E-5 (the cleanup is doc-side, signed in direction).** The DP-2-side 028 spec (`specs/028-pos-auth-boundary-and-operator-lifecycle/spec.md`, committed #544 / `0c57fed`) states **PI-1**: "The current `clerkJwt` OpenAPI security scheme name … [is] v1 implementation details / a legacy bridge, not the long-term domain model," and **DOC-2**: "Remove or rename the misleading Clerk-specific security scheme name (`clerkJwt`) wherever a provider-neutral identity scheme or an internal token is actually intended (PI-1)." Direction is owner-ratified at the boundary; D4 is the additive contract-side realization, **not yet implemented** (no role-named scheme exists on `origin/main`).
- **E-6 (the rename scope is POS-only; connector/service surfaces are ALREADY role-named).** `clerkJwt` is referenced in an *operation-level* `security:` block on **7 POS contracts only**: `catalog/read-down.yaml` (×2), `catalog/unknown-items.yaml` (×1), `pos-audit-events.openapi.yaml` (×1), `pos-operators.openapi.yaml` (×5), `pos-payments/vouchers.yaml` (×4), `pos-sales/sales.yaml` (×4 — deferred, E-3), `pos-shifts.openapi.yaml` (×1). The connector/erpnext surfaces do **NOT** authenticate with `clerkJwt`: `connector/connector-admin.yaml`, `erpnext-reconciliation/reconciliation.yaml`, and `erpnext-sync-ops/console-sync-ops.yaml` use `cookieAuth` (`dp2_session`, human Tenant-Admin session — explicitly "NOT the 012 `connectorBearer` machine scheme and NOT the POS `clerkJwt` device scheme"); `erpnext-connector/posting-feed.yaml` and `stock-view.yaml` use `connectorBearer` (the machine scheme, "NOT a Clerk JWT (`clerkJwt`) and NOT a human cookie session"). The `clerkJwt` strings my count found in those files are **prose disclaimers**, not active references. So D4 introduces **no `service` rename** — those surfaces are already correctly role-named; D4's active rename set is POS device + operator-identity surfaces only.

---

## 1. Summary

Across Data-Pulse-2's OpenAPI contracts, a single provider-named security scheme key — **`clerkJwt`** — labels three semantically different credentials: a provider-identity JWT (sign-in), an opaque **device** token (catalog read-down and other device surfaces), and a machine **service** bearer (connector/service surfaces). The name is misleading on every surface where the credential is not a Clerk operator JWT — most starkly on catalog read-down, where the contract *itself* documents that the credential is an opaque device token and flags the POS-wide rename as a deferred decision (E-2).

This draft specifies the **additive** half of the cleanup (028 §19 **DOC-1/DOC-2/DOC-4**; DP-2 028 **PI-1/DOC-2**): introduce **role-named security schemes** — `operator-identity` (provider-identity JWT) and `device` (opaque device token) — and re-point each *active* `clerkJwt` POS surface's `security:` at the scheme that matches its *current* runtime credential. Read-down (and the other device-authenticated POS surfaces) move to the `device` scheme; sign-in (and the other operator-identity POS surfaces) move to `operator-identity`. The active `clerkJwt` references are **POS-only — 7 contracts** (E-1/E-6). The connector/erpnext surfaces are **already** role-named on `origin/main` (`connectorBearer` machine, `cookieAuth` human session, E-6) and need **no rename**; the `service` role-name is carried as DOC-1 disambiguation vocabulary only, not a D4 change.

It deliberately **excludes the sale-sync rename** (`captureSale` / void / refund). Sale-sync's runtime is still a genuine Clerk JWT + `X-Device-Attestation` (Option-Y, E-3); renaming it before the internal operator-authorization envelope is built (drift item **D1**) would document an unbuilt credential and *create* the DOC-3 doc↔runtime mismatch the deferral exists to prevent. Sale-sync stays on `clerkJwt`, documented faithfully as Option-Y, and the rename co-delivers with D1.

This is a **contract-naming / documentation** change at spec altitude. It changes no guard, no token format, no DB schema, and no verification logic — only OpenAPI `securitySchemes` keys/descriptions and per-operation `security:` references.

## 2. Goals

- **G-1.** Introduce **role-named security schemes** in the DP-2 OpenAPI contracts — names that describe the credential's *role* (`operator-identity` / `device` / `service`), not the identity provider (DOC-1).
- **G-2.** **Retire the misleading `clerkJwt` key** on every surface where the credential is not a Clerk operator-identity JWT (DOC-2), starting with the read-down device mislabel (DOC-4).
- **G-3.** Ensure **catalog read-down (and other device-authenticated surfaces) document a `device` scheme** — opaque device token, no `bearerFormat: JWT`, no operator credential (DOC-4).
- **G-4.** Ensure **sign-in documents an `operator-identity` (provider-identity) scheme** that is honest as identity proof — not conflated with the sale-sync operator-authorization envelope (D1).
- **G-5.** Confirm **connector / service surfaces are already role-named** (`connectorBearer` machine; `cookieAuth` human session) and require **no rename** in D4 (E-6) — the `service` role-name is carried as DOC-1 disambiguation vocabulary only, consistent with 028 §15 / DOC-6.
- **G-6.** Keep the change **purely additive and doc↔runtime-honest** — every renamed surface's new scheme must match the credential the runtime *already* verifies today (no contract describing unbuilt behavior).
- **G-7.** **Explicitly defer the sale-sync rename to D1** and record the deferral in the contracts (sale-sync documented faithfully as Option-Y until the envelope lands).
- **G-8.** Preserve **scope non-interchangeability** in the contract surface (028 SR-10): device ≠ operator-identity ≠ service must be visible as distinct named schemes, not one shared key.

## 3. Non-goals

- **N-1.** No code, migration, OpenAPI/YAML, package, lockfile, CI, generated-file, runtime-config, secret, env, or deployment change in this task. (Orchestrator is docs-only; this is a DRAFT.)
- **N-2.** **No sale-sync scheme rename.** `captureSale` / void / refund (`pos-sales/sales.yaml`) keep `clerkJwt`/Option-Y here; their rename to an operator-authorization-envelope scheme co-delivers with **D1** (DOC-3). Touching `sales.yaml`'s sale-sync security is out of D4's scope.
- **N-3.** No change to any guard, verifier, token format, JWKS validation, or device-attestation mechanism. The runtime is untouched; only contract names/descriptions change.
- **N-4.** No DB migration and **no G3** dependency — a security-scheme rename carries no schema change.
- **N-5.** No provider-neutral *identity link* / `IdentityProviderPort` work — that is drift item **D3** (DP-2 §16). D4 only renames contract schemes; it does not build the neutral identity model.
- **N-6.** No re-specification of the 028 boundary or gate **G10**. D4 consumes G10; it does not define or mutate it.
- **N-7.** No client regeneration or POS/Console/Connector edit. Consumers re-generate against the renamed contracts as part of *their* slices, not here.
- **N-8.** No assertion that the cleanup is "done." No role-named scheme exists on `origin/main` (E-5); this is a target, recorded as such.

## 4. Scope fence — in / out (the load-bearing distinction)

> **Per-surface test:** *Does relabeling this surface's scheme keep its documentation matching today's runtime credential?* **Yes ⇒ in D4 (additive). No ⇒ deferred to D1.**

| Surface (DP-2 `origin/main`) | Current `security:` | Current runtime credential | D4 target scheme | In D4? |
|---|---|---|---|---|
| `catalog/read-down.yaml` (snapshot + delta, ×2 ops) | `clerkJwt` | opaque **device** pairing token (E-2) | `device` | **YES — additive** |
| `catalog/unknown-items.yaml` (×1 op) | `clerkJwt` | POS **device** principal (submitting device supplies tenant/store scope) | `device` | **YES — additive** (confirm per-operation in plan phase) |
| `pos-audit-events.openapi.yaml` (×1 op) | `clerkJwt` | **device-token-attestation** is the authoritative gate; the Clerk JWT is optional/may be absent ("validated against the device token's tenant + branch scope, not the Clerk JWT") | `device` | **YES — additive** (confirm per-operation in plan phase) |
| `pos-operators.openapi.yaml` sign-in / sign-out (×5 ops) | `clerkJwt` | genuine provider-identity JWT (E-4) | `operator-identity` (provider-identity) | **YES — additive** |
| `pos-shifts.openapi.yaml` (×1 op) | `clerkJwt` (`bearerFormat: JWT`) | genuine Clerk JWT, manager/admin roles only | `operator-identity` (provider-identity) | **YES — additive** (confirm per-operation in plan phase) |
| `pos-payments/vouchers.yaml` (×4 ops) | `clerkJwt` (`bearerFormat: JWT`) | genuine Clerk JWT POS bearer (same as shifts/audit) | `operator-identity` — **unless** an op is sale-adjacent, then DEFER | **YES — additive** where operator-identity (confirm per-operation; payment-adjacent ops may push to D1) |
| `pos-sales/sales.yaml` `captureSale` / `recordVoid` / `recordRefund` (×3 ops) | `clerkJwt` (`bearerFormat: JWT`) | genuine Clerk JWT + `X-Device-Attestation` (Option-Y, E-3) | (target operator-authorization-envelope scheme) | **NO — DEFERRED to D1** |
| `pos-sales/sales.yaml` `readSale` (×1 op) | `clerkJwt` | tied to the phantom `pos_operator` guard (drift D2) | (resolved with the D1/D2 slice) | **NO — DEFERRED to D1** |
| `connector/connector-admin.yaml`, `erpnext-reconciliation/reconciliation.yaml`, `erpnext-sync-ops/console-sync-ops.yaml` | `cookieAuth` (`dp2_session`) — **NOT `clerkJwt`** (E-6) | human Tenant-Admin / Console session | — already role-named (`cookieAuth`) | **NO — already correct; not in D4** |
| `erpnext-connector/posting-feed.yaml`, `erpnext-connector/stock-view.yaml` | `connectorBearer` — **NOT `clerkJwt`** (E-6) | machine service bearer (028 §15) | — already role-named (`connectorBearer`) | **NO — already correct; not in D4** |

> Surfaces marked "confirm per-operation in plan phase" require the owning repo to confirm, per operation, which credential the route's guard actually verifies before assigning a role-named scheme — the additive guarantee (G-6) holds only if the new name matches the verified runtime. Any surface that turns out to carry the sale-sync envelope is pushed to D1, not renamed here. The connector/erpnext surfaces are **already** role-named (`cookieAuth` for human-session, `connectorBearer` for machine) and need **no rename** — D4 introduces no `service` rename (E-6); the `service` *vocabulary* is used only conceptually for DOC-1 disambiguation (§5).

## 5. Target contract shape (spec altitude — no YAML authored)

The active `clerkJwt` references on the **7 POS contracts** (E-1/E-6) split into two role-named schemes; the connector/erpnext surfaces are already role-named and untouched:

- **`operator-identity`** — `type: http`, `scheme: bearer`, `bearerFormat: JWT`. The human operator's **provider-identity** JWT, presented at sign-in as identity proof, verified at the API edge (signature / `iss` / `aud` / `exp` / `nbf` / `iat`). Description states explicitly: *identity proof / sign-in evidence only — not business authorization* (028 §6 CM-1). This is the de-Clerk-ified rename of today's `clerkJwt` on the operator-identity POS surfaces (sign-in E-4; shifts; non-sale voucher ops, per per-operation confirmation); the *provider* (Clerk) is named only as the current implementation in prose, not in the scheme key.
- **`device`** — `type: http`, `scheme: bearer`, **no `bearerFormat: JWT`** (the credential is an opaque device token, not a JWT). The paired terminal's `devices` token, hashed and matched against an active non-revoked `devices` row, supplying the authoritative `(tenant_id, store_id)` scope. Description states: *device-scoped; never proves sale ownership alone* (028 §6 CM-2). This is the rename of `clerkJwt` on the device-authenticated POS surfaces — read-down (E-2, the canonical mislabel, with the contract's own deferred-rename note as warrant), unknown-items, and pos-audit-events (where the device-token attestation is the authoritative gate, not the optional Clerk JWT).
- **`service` (vocabulary only — no rename in D4).** The role-name for machine/service-to-service surfaces (028 §15 `connectorBearer`; CM-5 / DOC-6) is named here for DOC-1 disambiguation completeness, but the connector/erpnext surfaces **already** carry correct role-named schemes on `origin/main` (E-6): `connectorBearer` (machine) on `posting-feed` / `stock-view`, and `cookieAuth` (`dp2_session`, human Tenant-Admin session) on `connector-admin` / `reconciliation` / `console-sync-ops`. D4 therefore introduces **no `service` scheme and no connector/erpnext rename** — those surfaces are out of D4's active set.

Each in-scope POS operation's `security:` list is re-pointed from `clerkJwt` to the `device` or `operator-identity` scheme matching its verified runtime credential. Sale-sync operations are **left on `clerkJwt`** with a description note that the rename co-delivers with the operator-authorization-envelope work (D1 / DOC-3). Final scheme **key spellings** (`operator-identity` vs `operatorIdentity` vs `posOperatorAuth`; `device` vs `posDeviceAuth`) are plan-phase naming decisions for the owning repo, not boundary decisions — the requirement is role-descriptive and not-confusable (DOC-1).

## 6. Migration / rollout shape (for the owning repo, post-dispatch)

- **Additive-first.** Introduce the role-named schemes *alongside* `clerkJwt`, re-point the in-scope operations, and remove `clerkJwt` only from surfaces fully migrated — leaving `clerkJwt` in place on the deferred sale-sync surfaces until D1 lands. This avoids a flag-day where every contract changes at once.
- **Consumer regeneration is downstream.** POS-Pulse, Console, and Connector regenerate their generated clients against the renamed schemes as part of *their* slices (028 §20). D4 delivers the contracts; it does not edit consumers (N-7).
- **No runtime coupling.** Because the rename is doc↔runtime-honest by construction (G-6), no guard or verifier changes; the contract simply names what the runtime already does.
- **Sale-sync handoff.** When D1 mints+returns the operator-authorization envelope and re-wires sale-sync, the *same* additive pattern retires the residual `clerkJwt` on `sales.yaml` (DOC-3 completes there, not here).

## Acceptance criteria

- **A-1** Role-named schemes (`operator-identity` / `device` / `service`) are defined as the target, with role-descriptive (not provider-named) keys (DOC-1).
- **A-2** The misleading `clerkJwt` key is retired on every in-scope surface where the credential is not a Clerk operator-identity JWT (DOC-2).
- **A-3** Catalog read-down (and other device surfaces) are specified to document a `device` scheme — opaque token, no `bearerFormat: JWT`, no operator credential (DOC-4); grounded in E-2.
- **A-4** Sign-in is specified to document an `operator-identity` (provider-identity) scheme as identity proof, not business authorization (E-4; 028 §6 CM-1).
- **A-5** Connector/service surfaces are confirmed **already role-named** (`connectorBearer` / `cookieAuth`, E-6) and out of D4's active rename set; the `service` role-name is documented as DOC-1 disambiguation vocabulary, not a rename (DOC-6; 028 §15).
- **A-6** Every renamed surface's target scheme matches the credential its runtime verifies **today** — no contract describing unbuilt behavior (G-6).
- **A-7** The sale-sync rename is **excluded** and explicitly deferred to D1, with sale-sync documented faithfully as Option-Y in the interim (DOC-3; N-2).
- **A-8** The change is recorded as contract-only — no migration, no guard change, no token-format change; gates = G10 + G2, **not G3**.
- **A-9** Scope non-interchangeability is visible as distinct named schemes (028 SR-10; G-8).
- **A-10** No implementation, contract, or migration was authored in this draft; no role-named scheme is claimed present on `origin/main` (E-5).

## Dependencies & sequencing

> Cites the verified DAG in `docs/roadmap/auth-028-drift-map.md`.

- **Gate: G10 (Identity & Access Boundary).** This is an auth/identity/access surface — **gated; requires owner approval + G10 verification before any dispatch.**
- **Gate: G2 (contract).** The deliverable is OpenAPI contract changes. **No G3** (no migration).
- **D1 → D4 edge: REFUTED.** The drift map's adversarial review **dropped** the D1→D4 dependency: DOC-1/2/4 are additive and **startable now**, parallel to the DP-2 spine (D3 → D1+D2 → D5+D7). The repo's contract-first norm would *reverse* the edge, but D4 is a doc-tracks-runtime cleanup; DOC-3 reads "match runtime auth today (Option-Y) **and** track the later move." Documenting `pos_operator` while the runtime still enforces a Clerk JWT would *create* the mismatch DOC-3 exists to kill.
- **The ONLY D1 coupling** is the carved-out **sale-sync rename** (the `sales.yaml` capture/void/refund surfaces, N-2), which co-delivers with D1. Everything else in D4 needs nothing from D1.
- **No dependency on D3.** D4 renames contract schemes; it does not build the provider-neutral identity link / `IdentityProviderPort` (D3). The `operator-identity` scheme names the *provider-identity JWT* honestly today; it does not presuppose D3's neutral link.
- **Build-order position (drift map):** item **3** — "D4 — DP-2 contract cleanup — startable in parallel (refuted off D1; DOC-3 documents Option-Y faithfully until the envelope lands)."
- **Severity:** LOW (drift-map D4 row) — a naming/documentation cleanup, not a behavior change.

## Open questions

> Carried forward from 028; D4 does **not** auto-decide these. None of the genuinely-open 028 OQs bear on contract scheme naming, so they are *out of scope here* rather than resolved by D4.

- **OQ-2 / OQ-3 / OQ-4 / OQ-9 / OQ-11** (manager offline override; PIN complexity/retry-lock; multi-terminal sessions; local refresh-token storage; break-glass for pilot) — all **out of scope for D4**; they concern offline/operator behavior, not contract naming. Left open at the 028 boundary; D4 neither resolves nor depends on them.
- **D4-OQ-1 (plan-phase, owning repo).** Final scheme **key spellings** and whether the connector `cookieAuth` surfaces also get a description-only disambiguation pass — a naming detail for the owning repo, not a boundary decision (§5).
- **D4-OQ-2 (plan-phase, owning repo).** Per-operation runtime confirmation for the "verify in plan phase" surfaces (`pos-audit-events`, `pos-shifts`, `pos-terminal-pairing`, `vouchers`, and the catalog reads beyond read-down) — each must be confirmed device vs operator-identity before a role-named scheme is assigned (G-6). Any surface found to carry the sale-sync envelope is pushed to D1.

---

> **Docs-only record (SHIPPED — MERGED to `main` 2026-06-12, PR #551 `33515a6`).** This draft records the additive contract-cleanup target and the verified current runtime as-built.
