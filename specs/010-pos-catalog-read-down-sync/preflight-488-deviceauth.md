# Maestro Preflight — Issue #488: Read-Down Device-Principal Auth

**Repo:** `ahmed-shaaban-94/Data-Pulse-2`
**Issue:** [#488](https://github.com/ahmed-shaaban-94/Data-Pulse-2/issues/488) — *Spec 010 read-down auth: guard rejects device-principal (no-session) requests — contradicts FR-001; blocks POS-Pulse 010*
**Prepared by:** agent (Claude Code), 2026-06-04 — **PREFLIGHT ONLY; no code/contract/migration touched.**
**Working branch / SHA:** preflight written in worktree `preflight/488-readdown-deviceauth` off `origin/main` @ `4012439` (the in-flight `feat/013-crud-impl` work was NOT disturbed).
**Authoritative sources:** all reads firsthand from `origin/main` (not the working branch, not CLAUDE.md prose).

---

## VERDICT: 🟡 GO WITH CONDITIONS — approve direction **Option B-prime** + one `[GATED]` allow; then implement

**The task brief's *literal* direction is unworkable, but a correct, small alternative exists.** The brief said
"allow the `pos` token scope; scope store from the device principal" — that targets the `auth_tokens` `pos`
bearer, which (a) **isn't even minted** today and (b) carries **no store**, so pursuing it forces a GATED
migration + new mint path + 002/pairing touch (= the large **Option A**). **Stop on that path.**

**But #488 is solvable without any of that** via **Option B-prime**: authenticate the **`devices` pairing
token** directly (the credential POS already issues), resolving `(tenant_id, store_id)` from the store-bound
device **row** through the already-shipped `findActiveByAttestation`. This needs **no migration, no new token
mint, no sign-in change** — only a new read-down-only guard + a context seam + **one GATED surface** (the
OpenAPI security-scheme alignment, expected per D-AUTH-1). It honors every task constraint A violates.

**Conditions before implementation (per `standing-rules.md` §3/§7 — gated surfaces cannot self-grant):**
1. Owner approves **Option B-prime** as the direction (vs A / C).
2. Owner grants the **`[GATED]`** allow for `packages/contracts/openapi/catalog/read-down.yaml` (security scheme).
3. Implementation runs in an **isolated branch/worktree**, read-only-default → single edit path, **stop before
   commit** (the user's "work in a worktree" instruction + standing-rules default).

---

## 0. Premise correction (read first)

The task framing ("resolve the contradiction … do not implement until preflight approved") is valid, but two
premises are stale and must be named:

1. **Backend 010 is CLOSED and shipped on `main`** (10/10 slices merged 2026-06-04 — `CLAUDE.md:31,57`;
   verified: `read-down.controller.ts`, `read-down.service.ts`, `0015` change-log, contract, tests all on
   `origin/main`). This is **NOT** finishing in-flight work — it is **reopening merged code**. A legitimate
   owner request, but the change lands on shipped surfaces, not a live slice.

2. **CLAUDE.md says the auth concern was "resolved in-build"** (*"the contracts/README's `posDeviceAuth` was a
   mislabel (the device scheme is `clerkJwt`)"*). That statement is about the **OpenAPI label**, not the
   **guard behaviour**. The guard behaviour — read firsthand — still rejects device-only requests. **#488 is
   genuinely open.** (Issue is `OPEN`, 0 comments, as of this preflight.)

---

## 1. Ground truth — what the merged code actually does

| Fact | Evidence (`origin/main`) |
|:--|:--|
| Both read-down routes guard with `@UseGuards(PosOperatorAuthGuard, TenantContextGuard)` | `apps/api/src/catalog/read-down/read-down.controller.ts` (`getSnapshot`, `getDeltas`) |
| `PosOperatorAuthGuard` requires `principal.scope === "pos_operator"` and **rejects the plain `"pos"` device scope** | `apps/api/src/auth/pos-operator-auth.guard.ts:42` (allow), `:13` (reject `pos`) |
| `pos_operator` is issued **only at operator sign-in** (derived from Clerk JWT + device + tenant + store) | `.specify/memory/decisions/0001-pos-operator-identity-wave1.md` D8 |
| `AuthGuard` authenticates a single opaque `Authorization: Bearer <raw-token>`; no Clerk-JWT verify, no `X-Terminal-Token` | `apps/api/src/auth/auth.guard.ts:127-171` |
| **A `pos`-scope device token carries NO store binding** | `auth.guard.ts` Principal comment (*"`pos` scopes carry no store binding … null"*); `auth_tokens.ts:46` (*store_id "Required for `pos_operator`; NULL for any other scope"*) |
| `TenantContextGuard` resolves `storeId` directly from `principal.storeId` (null for `pos`) | `apps/api/src/context/tenant-context.guard.ts:167` |
| Read-down controller **rejects `ctx.storeId === null`** with `store_context_required` (401) | `read-down.controller.ts` (`getSnapshot`/`getDeltas`) |
| The as-built isolation test only asserts the **negative** cases (anonymous → 401, null-tenant manager → 401); the device-only `pos`-scope case is **untested** (the harness uses a `ConfigurableContextGuard` that bypasses the real bearer→scope path) | `apps/api/test/catalog/read-down/isolation/device-auth-required.spec.ts` |

**Conclusion:** a device-token-only background request (POS-Pulse's owner-ratified no-operator-session trigger)
is rejected today on two independent grounds: (a) `pos` scope is refused by `PosOperatorAuthGuard`; (b) even if
accepted, `pos` carries no store, so the controller's `store_context_required` guard rejects it. **Fixing (a)
without (b) produces an endpoint that still 401s.**

---

## 2. Two distinct objects — keep them separate (this is the whole crux)

There are **two** "device" credentials in this repo, and conflating them is what makes #488 look harder than it
is. The store binding the read-down needs **exists** — just not on the object the task brief assumed.

| Object | Store binding? | Minted today? | Request-time usable? |
|:--|:--|:--|:--|
| **`auth_tokens` `pos`-scope row** (a bearer token) | ❌ NO — `auth_tokens.ts:46` + the `auth_tokens_principal_by_scope` CHECK forbid `store_id` on any scope but `pos_operator` | ❌ **NO issuance path found in `apps/api/src`** — the only POS bearer minted is `pos_operator` (`pos-operators.service.ts:24`) | n/a (doesn't exist) |
| **`devices` pairing token** (the terminal trust factor) | ✅ **YES — `devices.store_id` is `NOT NULL`** (`devices.ts:30-32`); `tenant_id` also NOT NULL (`:27-29`) | ✅ pairing creates the `devices` row; hash stored, revocable | ✅ **YES** — see §2a |

**So:** the task brief's literal direction ("allow the `pos` token scope; scope store from the device
principal") is built on the **first** object — which has no store and **isn't even minted**. Pursuing that
forces a token-shape change: a GATED `auth_tokens` CHECK migration + a new mint path + a 002/pairing touch +
the GATED OpenAPI scheme. That is the **Option A blast radius** and collides with the forbidden list ("no
operator sign-in / no broad auth refactor") + `standing-rules.md` §3/§7.

**But the read-down doesn't need that token.** It needs `(tenant_id, store_id)` for the terminal — and that
lives on the **`devices` row**, which the pairing token already resolves. → **Option B-prime** (§3).

### 2a. The device pairing token IS a request-time credential (the discriminator, now settled)

`DeviceRepository.findActiveByAttestation(rawAttestation)` (`apps/api/src/pos-operators/device.repository.ts:40`)
is a **stateless, self-contained** check: hash the raw token → single UNIQUE-index probe on `devices.token_hash`
→ return the store-bound `DeviceRow` iff `revoked_at IS NULL`, else null. It is **NOT** sign-in-specific:

- It needs **no established tenant context** — the comment (`:9-13`) states *"at sign-in time the request has no
  established tenant context (the device is the source of that context)"*. That is precisely the property a
  request-time guard needs.
- It consumes **no session**, mutates nothing, and returns the canonical `(tenant_id, store_id)` directly.

Sign-in happens to call it from a request **body** field today, but nothing constrains it to the body — a guard
can call the same repo method on a header/bearer value per request. **The device pairing token is presentable
per-request.** This is the read that §5 of the first pass deferred; it is now done, and it flips the
recommendation from "B collapses to A" to "B-prime is the smallest correct path."

---

## 3. The real decision the owner must make (the escalation)

The honest blocker is a **design choice about how a no-session device principal carries store scope.** Three
candidate directions — each with a different gate/scope cost. **This is the decision to approve, not a slice.**

| Option | What it is | Gates touched | Fit |
|:--|:--|:--|:--|
| **B-prime — authenticate the `devices` pairing token directly** ⭐ | A new device-principal guard reads the terminal's pairing token (header/bearer), resolves it via the existing `findActiveByAttestation` → store-bound `DeviceRow`, and populates `(tenant_id, store_id)` onto the request context. No `auth_tokens` token involved at all. | New guard + a context-population path + OpenAPI scheme **[GATED]**. **No migration. No new mint path. No 002/sign-in change.** | **Smallest correct path.** Reuses the credential pairing already issues + the lookup already shipped; the store is on the device row (§2). Matches the backend's own quickstart (`Authorization: <device token>`) and POS-Pulse's `X-Terminal-Token` intent. **Recommended.** |
| **A — Store-bound `auth_tokens` `pos` token** | Mint a new `pos`-scope bearer with a `store_id`; new guard accepts it; controller reads `ctx.storeId` as today. | SQL migration (`auth_tokens` CHECK) **[GATED]** + new mint path + 002/pairing issuance + OpenAPI scheme **[GATED]** | Cleanest *token-model* end state but **largest blast radius** — reopens the 002 auth model + adds a token-issuance path that doesn't exist today. Only if B-prime proves unworkable. |
| **C — POS keeps an operator session for read-down** | No backend change; POS-Pulse re-opens its own Q-RD-TRIGGER and runs read-down inside an operator session. | None backend | Pushes cost cross-repo; contradicts POS's owner-ratified no-session trigger (Constitution VIII). Fallback only. |

**Recommendation:** **Approve Option B-prime**, then scope a single read-only-default slice around it (touch-list
in §4). It honors every task constraint that A violates: no `PosOperatorAuthGuard` broadening (separate guard),
no operator-sign-in change, no migration, no broad auth refactor — the only GATED surface it needs is the
OpenAPI security-scheme alignment (expected, and called out in D-AUTH-1). Do NOT authorize edits yet — approve
the direction + the `[GATED]` OpenAPI allow first.

---

## 4. If Option B-prime is approved — provisional touch-list

> Provisional. NOT an authorization to edit — approval of the direction + the `[GATED]` OpenAPI allow comes first.

- **Files to add:**
  - `apps/api/src/auth/pos-device-auth.guard.ts` (new) — reads the terminal pairing token from the request
    (header/bearer), calls `DeviceRepository.findActiveByAttestation`, and on a non-null `DeviceRow` publishes a
    device principal `(tenant_id, store_id, device_id)` onto the request. Rejects (401) on: no token, revoked
    token (repo returns null), and any non-device credential (session cookie / `dashboard_api` / a bearer that
    isn't a device token). Structurally mirrors `PosOperatorAuthGuard`'s allow/deny rigor — **does NOT extend
    or broaden `PosOperatorAuthGuard`** (separate file; the shared guard's other consumers are untouched).
- **Files to touch:**
  - `apps/api/src/catalog/read-down/read-down.controller.ts` — swap `@UseGuards(PosOperatorAuthGuard, …)` →
    `@UseGuards(PosDeviceAuthGuard, TenantContextGuard)` (or have the new guard populate `req.context` directly),
    **on the two read-down routes ONLY**.
  - `apps/api/src/catalog/read-down/read-down.module.ts` — provide the new guard + `DeviceRepository` (already
    in `PosOperatorsModule`; import or re-provide minimally).
  - the context-population seam — the new guard sets `req.context.{tenantId, storeId}` from the `DeviceRow` so
    the controller's existing `store_context_required` / `branch_id`-mismatch logic works **unchanged**. (No
    `auth_tokens`, no `Principal.deviceId` core change required — the guard owns resolution end-to-end.)
- **GATED (needs explicit allow):** `packages/contracts/openapi/catalog/read-down.yaml` — align the security
  scheme + description from the operator-JWT (`clerkJwt`) framing to a device-principal scheme. **This is the
  one gated surface B-prime needs.**
- **Tests to add/adjust:**
  - `device-auth-required.spec.ts` — add a **real-guard** positive case (valid pairing token → 200 with a
    resolved store) and negatives (revoked token → 401; session/`dashboard_api` → 401). ⚠ The current harness
    uses a `ConfigurableContextGuard` that **bypasses the real auth path** — a real-guard integration test
    against a seeded `devices` row is required so the fix is genuinely proven, not just the context layer.
  - `scope-mismatch.spec.ts` / `store-context-required.spec.ts` — confirm still green under the new guard
    (store-mismatch → non-disclosing 404; no resolved store → `store_context_required`).
  - `read-down.contract.spec.ts` (conformance) — re-run after the OpenAPI scheme change.

---

## 5. A/B discriminator — RESOLVED (this read is now done)

The first pass deferred one read; it has been made:
- **`devices.store_id` is `NOT NULL`** (`packages/db/src/schema/devices.ts:30-32`), `tenant_id` NOT NULL (`:27-29`)
  — every device row binds exactly one `(tenant, store)`.
- **`findActiveByAttestation` is a stateless request-usable lookup** (`device.repository.ts:40`, §2a) — returns
  the store-bound row from a raw token, no session/context required.

→ **Option B-prime is viable with NO migration.** The store binding is on the device **row** (present), even
though the `auth_tokens` token **shape** carries none (absent) — two different objects (§2). This is the
discriminator the first pass flagged; it lands on B-prime, not A.

---

## 6. Security risks (whichever option)

1. **Scope-confusion (critical).** A new device-principal guard MUST reject `session` (dashboard cookie),
   `dashboard_api`, and any non-device bearer — exactly as `PosOperatorAuthGuard` does. A guard that merely
   "also allows `pos`" without re-asserting the full reject set widens the attack surface. Mirror the existing
   guard's allow/deny structure precisely.
2. **Store authority (P17 / FR-002).** Store/tenant must come from the authenticated device **row** ONLY —
   B-prime takes `(tenant_id, store_id)` straight from the `DeviceRow` that `findActiveByAttestation` returns
   for the presented token, never from request body/query. The existing non-disclosing `branch_id`-mismatch →
   404 (`read-down.controller.ts`) must remain.
3. **No broadening of `PosOperatorAuthGuard`** (task constraint, correct) — `posCaptureItem` and the 008 sales
   POS routes share it; broadening would silently expand their auth. Use a **separate** guard.
4. **Credential transport (D-AUTH-2).** Backend reads `Authorization: Bearer <token>`. POS-Pulse constitution
   mandates `X-Terminal-Token`. **No `X-Terminal-Token` seam exists in this repo** (grep of guards = none).
   D-AUTH-2's "use `Authorization: Bearer <device_token>` unless an X-Terminal-Token seam is proven" → **the
   seam is NOT proven; default to `Authorization: Bearer`** (POS-Pulse sends the device token there for this
   surface — a documented per-surface decision on the POS side).

---

## 7. Contract / docs changes (all GATED)

- `packages/contracts/openapi/catalog/read-down.yaml` — security scheme + description currently frame
  operator-JWT (`clerkJwt`); must be aligned to device-principal. **[GATED — `packages/contracts/openapi/**`].**
- `specs/010-pos-catalog-read-down-sync/contracts/README.md`, `quickstart.md` — already say "device-principal,
  NOT Clerk-JWT"; would become accurate once the guard matches (docs-only, non-gated).
- A new decision record under `.specify/memory/decisions/` recording the A/B/C choice (docs-only).

---

## 8. Deployment confirmation plan (D-DEPLOY)

After the auth change merges:
1. Regenerate / re-pin the catalogue OpenAPI; confirm `read-down.yaml` `version` + the device-principal scheme
   are the deployed shape at the API edge.
2. Smoke: a paired terminal's device token (no operator session) → `GET /api/pos/v1/catalog/snapshot` → 200 with
   a cursor; the same with a `dashboard_api`/session credential → 401; a `branch_id` mismatch → non-disclosing 404.
3. Notify POS-Pulse 010 to re-pin `src/shared/api-types.ts` and lift its §A6/§A2 holds (POS-Pulse
   `a6-reconciliation-findings.md` / issue cross-ref).

---

## 9. What was verified vs deferred

- **Verified firsthand (`origin/main`):** controller guards, `PosOperatorAuthGuard`, `AuthGuard`,
  `TenantContextGuard` store resolution, `auth_tokens` scope/CHECK + `BearerAuthScope`, **no `pos`-scope
  issuance path in `apps/api/src` (only `pos_operator` minted — `pos-operators.service.ts:24`)**, **`devices`
  schema (`store_id` NOT NULL)**, **`findActiveByAttestation` is a stateless request-usable lookup**, the
  as-built isolation test (real auth bypassed by `ConfigurableContextGuard`), standing-rules gate discipline,
  010-closed status, issue #488 OPEN.
- **Deliberately deferred to the implementation slice (not blockers):** the exact context-population seam diff
  (whether the new guard sets `req.context` directly or via a thin resolver) — a small design choice made at
  edit time; the precise OpenAPI security-scheme wording (drafted under the `[GATED]` allow).

---

**Final line:** Do not implement until owner explicitly approves the selected direction (recommended:
**Option B-prime**) and the required `[GATED]` allow (the `read-down.yaml` OpenAPI security scheme; + a
migration only if Option A is chosen instead).
