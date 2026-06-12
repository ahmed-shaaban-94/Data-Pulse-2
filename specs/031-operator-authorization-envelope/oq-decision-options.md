# 031 — Open-Question Decision Options (owner brief to tee up approval)

> **DECISION-SUPPORT, NOT DECISION-MADE.** This annex presents options + a recommendation for each carried Open Question in [`spec.md`](./spec.md) §8 so the owner can ratify a direction. It **does not** mark any OQ resolved, does not mutate `spec.md`'s carried-OQ section, and does not advance the gate. The spec stays SPECIFY+CLARIFY-only until owner approval + G10 verification (spec.md §Dependencies). Nothing here asserts the reconciliation is built (SC-09).
>
> **Placement (owner can redirect):** authored at `specs/031-operator-authorization-envelope/oq-decision-options.md`. `specs/**` is not a `[GATED]` path, so no gate approval was required to author this prose; it is planning input that would feed the owning repo's plan phase **after** approval. No `plan.md`/`tasks.md` is implied or created.
>
> **Status:** DRAFT — for owner review. **Date:** 2026-06-12. **Owning repo:** Data-Pulse-2. **Decider:** Owner (Ahmed Shaaban).

---

## How to read this brief

Each OQ falls into one of two classes, and that class **determines whether DP-2 may recommend at all**:

| Class | Meaning | DP-2's posture |
|---|---|---|
| **DP-2-local** | DP-2 owns the artifact the question decides (`auth_tokens`, the guard, the transport header). | **Recommend** — owner ratifies. |
| **028-boundary mirror** | The question *is* an unresolved 028 boundary question (OQ-9 / OQ-4). DP-2 only consumes the boundary's answer. | **Defer** — present DP-2-side *implications* of each upstream resolution; do **not** pick. Crossing this fence violates the §0 scope fence and 028 §0/§5 credential ownership. |

| OQ | Question | Class | This brief's posture |
|---|---|---|---|
| OQ-1 | Envelope wire format | DP-2-local | **Recommend** (with one live sub-fork) |
| OQ-2 | TTL | DP-2-local | **Recommend** (coupled to OQ-3) |
| OQ-3 | Refresh model (= 028 OQ-9) | 028-boundary | **Defer** — implications only |
| OQ-4 | Multi-terminal / takeover (= 028 OQ-4) | 028-boundary | **Defer** — implications only |
| OQ-5 | Transport / scheme | DP-2-local (contract-phase) | **Recommend** + cross-spec flag |

**Runtime evidence basis** (read this session, `origin/main`): `apps/api/src/auth/auth.guard.ts`, `apps/api/src/auth/pos-operator-auth.guard.ts`, `apps/api/src/pos-operators/pos-operators.service.ts`. The decisive fact threaded through every recommendation below: the canonical verification path **already exists end-to-end** — `AuthGuard.canActivate` reads `Authorization: Bearer <raw>` → `AuthTokenRepository.findActiveByRawToken(raw)` (hash lookup against `auth_tokens`, filters revoked/expired uniformly per FR-ISO-4) → `principalFromToken` → `{ kind: "token", scope: "pos_operator", tenantId, userId, storeId }`, and `BEARER_AUTH_SCOPES` **already contains `pos_operator`**. So the canonical guard's demand is satisfiable today by *any* presented raw token that resolves to the minted row. What is missing is purely **(a)** returning a presentable form at sign-in and **(b)** pointing the sale-write routes at the canonical guard — exactly the spec's "return + re-wire, not build-from-zero" framing (§1).

---

## OQ-1 — Envelope wire format  *(DP-2-local → RECOMMEND)*

**Question (spec.md §8 OQ-1):** Opaque revocable bearer vs signed/structured token vs a new representation.

**Why DP-2 may recommend:** DP-2 owns `auth_tokens` (the server-side state of record, §5) and the verification path. This is an internal-credential format choice, not a boundary decision.

### Options

| Option | What it is | Delta from `origin/main` | Revocation story | Key management |
|---|---|---|---|---|
| **1-A — Opaque revocable bearer (RECOMMENDED)** | The presentable credential is an opaque random string; the server resolves it by hash against the `auth_tokens` `pos_operator` row, exactly as `findActiveByRawToken` already does for every other bearer scope. | **Smallest.** Verification path is fully built; `pos_operator` is already in `BEARER_AUTH_SCOPES`. Only sign-in's return shape changes. | **Already works** — sign-out's `UPDATE auth_tokens … revoked_at` + the guard's "filter revoked uniformly" instantly invalidates the credential. No new mechanism. | None. Matches the stack's house pattern: "opaque revocable bearer tokens (API/POS)". |
| **1-B — Signed/structured token (e.g. JWT-shaped)** | The credential carries signed claims; verified by signature, not (or in addition to) a DB lookup. | **Large.** New mint/verify code, new verification branch in `AuthGuard`, claims schema. | **Regresses.** A purely-signed token can't be revoked before expiry without re-introducing a DB denylist — i.e. re-inventing the `auth_tokens` lookup it replaced. Sign-out's existing `revoked_at` UPDATE stops being sufficient. | **New burden** — signing key issuance, rotation, storage. None of this exists for operator sessions today. |
| **1-C — New representation / new column** | A distinct presentable artifact not backed by the existing row's material. | Medium–large; implies schema work (a `[GATED]` migration) the spec's §5 explicitly avoids asserting. | Depends on design; no advantage over 1-A. | Possible new burden. |

### Recommendation: **1-A (opaque revocable bearer).**
Lowest delta, reuses the entire verification + revocation path, no key management, and it is the credential primitive the stack already standardizes on. 1-B's signed shape actively *breaks* the DB-backed revocation that sign-out already provides — a real cost the owner should weigh, not a rubber-stamp.

### ⚠ Live sub-fork inside 1-A — owner must pick (this is what spec.md N-5 fences):
`issueOperatorSessionRow` today generates `opaqueRaw = generateRawToken()`, stores `hashToken(opaqueRaw)`, and **discards `opaqueRaw`**.

- **1-A-i — Return the currently-discarded raw.** Smallest possible diff: stop discarding, return it. *Risk:* that raw was minted as pure session-state filler (its only job today is satisfying the `token_hash NOT NULL UNIQUE` column); repurposing filler as a live credential should be a deliberate choice, not a side effect.
- **1-A-ii — Mint a distinct presentable opaque, separate from the row's `token_hash` filler.** Slightly larger; keeps "row-state material" and "client credential" conceptually separate.

**This brief does NOT collapse the sub-fork** — spec.md §8/N-5 says verbatim *"do not assume 'return the discarded raw token.'"* Recorded as an owner/plan-phase pick. (Lean: 1-A-i is lowest-delta and adequate; 1-A-ii is cleaner if the owner wants credential-vs-state separation to be explicit. Owner decides.)

---

## OQ-2 — TTL  *(DP-2-local → RECOMMEND, coupled to OQ-3)*

**Question (spec.md §8 OQ-2):** Envelope lifetime vs today's `OPERATOR_SESSION_TTL_MS`; whether sale-sync TTL differs from sign-in session TTL.

**Current runtime:** `OPERATOR_SESSION_TTL_MS = 8h` (shift-aligned), code comment: *"not refreshable (FR-POS-AUTH-5)."*

### Options

| Option | TTL | Tradeoff |
|---|---|---|
| **2-A — Reuse the existing 8h shift-aligned TTL (RECOMMENDED)** | One TTL governs sign-in session **and** the presented envelope. | Lowest delta; the envelope IS the session, so one expiry is the simplest mental model and matches a working shift. |
| **2-B — Shorter envelope TTL than the session** | e.g. session 8h, envelope minutes/short. | **Only buys blast-radius reduction if paired with refresh (OQ-3).** Without refresh, a short TTL just forces re-sign-in mid-shift — a UX regression with no security gain, because the underlying session is still live. |

### Recommendation: **2-A — reuse 8h**, *conditional on OQ-3*.
TTL is **coupled to refresh**: a short envelope TTL is only coherent if 028 OQ-9 (refresh) resolves "refreshable." Until OQ-3 is decided upstream, 2-A is the only self-consistent choice. If 028 later adopts refresh, revisit toward 2-B at plan phase. **Do not pick 2-B before OQ-3 resolves.**

---

## OQ-3 — Refresh model  *(= 028 OQ-9 → DEFER; implications only)*

**Question (spec.md §8 OQ-3):** Whether the envelope is refreshable and whether POS ever stores a refresh credential locally. **This is 028 OQ-9 verbatim — an unresolved boundary question.**

**DP-2 posture: DEFER.** DP-2 must not issue a confident pick on an unresolved 028 boundary question; refresh-credential storage on the POS client is squarely a boundary/POS-Pulse concern (D5), and a local refresh credential touches 028's credential-ownership rules. Present implications, await 028.

| If 028 OQ-9 resolves… | DP-2-side implication |
|---|---|
| **No refresh (current default)** | Keep 2-A (8h, re-sign-in at expiry). Zero new DP-2 surface. Matches today's `FR-POS-AUTH-5` "not refreshable" comment — the **fallback if 028 stays silent.** |
| **Refresh, server-issued, POS holds a refresh credential** | DP-2 gains a refresh endpoint + a second credential lifecycle; enables short envelope TTL (2-B). POS-side storage is D5, **not** this slice. New 028-governed credential-ownership review needed. |
| **Refresh without local POS storage** (e.g. silent re-mint on a live session) | Middle ground; DP-2 re-mints on presentation of the still-live session. Plan-phase design. |

**Fallback if 028 is silent at dispatch time:** default to **no refresh** (current behavior) + 2-A. Do not invent a refresh model locally.

---

## OQ-4 — Multi-terminal / takeover  *(= 028 OQ-4 → DEFER; implications only)*

**Question (spec.md §8 OQ-4):** Whether one operator may hold a live envelope on multiple terminals, or whether takeover forces single-session. **This is 028 OQ-4 verbatim.**

**DP-2 posture: DEFER** — boundary-owned. But note what the envelope **inherits for free** from existing runtime:

- Sign-in already calls `activeOperatorSessionExists(deviceId, storeId)` and returns `takeover_required` instead of minting a second session for the same `(device, store)` (service step 6).
- `takeoverConfirm` already revokes the prior session (`revokeActiveOperatorSession`) before issuing the new one, with `event_id` idempotency.

**Implication:** because the envelope **is** the `auth_tokens` row, single-session-per-`(device,store)` is already enforced — the envelope does not weaken it. The genuinely-open part (one operator across *multiple distinct terminals/devices* simultaneously) is the 028 OQ-4 question and is **not** decided here. Whatever 028 rules, the envelope follows the row's lifecycle automatically.

---

## OQ-5 — Transport / scheme  *(DP-2-local, contract-phase → RECOMMEND + cross-spec flag)*

**Question (spec.md §8 OQ-5):** Header name / transport for the envelope on the sale routes; ties to 028 §19 DOC-1/3.

### Recommendation: **reuse `Authorization: Bearer <envelope>`.**
That is precisely the path `readBearerToken` + `findActiveByRawToken` already serve for every bearer scope. With OQ-1 = opaque (1-A), the envelope drops straight into the existing transport with **zero** new parsing. The DOC-3 sale-route scheme rename co-travels with this slice (spec.md §6 note) — but the *transport mechanism* is settled by reuse.

### ⚠ Cross-spec consistency flag — surfaces at contract phase, worth the owner seeing now:
**030 (shipped, PR #551) already defined an `operator-identity` security scheme described as "JWT, identity-proof-only."** That scheme is for the **identity-proof** Clerk JWT, **not** an authorization credential. If the envelope is opaque + authz (OQ-1 = 1-A), then:

- The re-wired sale routes (`captureSale`/`recordVoid`/`recordRefund`) need a scheme describing an **opaque `pos_operator` authorization bearer** — semantically distinct from 030's `operator-identity`.
- **Reusing `operator-identity` for the sale routes would be a category error** (labeling an authz credential as identity-proof) and would re-create the kind of contract↔runtime mismatch 028 §19 DOC-3 exists to kill.
- **Recommended contract-phase action:** introduce a *distinct* authorization-credential scheme (e.g. `pos-operator-envelope`/`operator-authorization`) for the re-wired routes, rather than reuse 030's `operator-identity`. This is contract-phase work; flagged here so the plan phase budgets for a new scheme, not a reuse.

---

## Consolidated owner ask

To tee up approval, the owner ratifies the **DP-2-local** picks and acknowledges the **deferred** boundary mirrors:

| OQ | Recommended pick | Owner action |
|---|---|---|
| OQ-1 format | **1-A opaque revocable bearer** | ✅ ratify direction · **+ pick sub-fork 1-A-i vs 1-A-ii** |
| OQ-2 TTL | **2-A reuse 8h** (conditional on OQ-3) | ✅ ratify |
| OQ-3 refresh (= 028 OQ-9) | **Defer to 028**; fallback = no refresh | ☐ acknowledge defer |
| OQ-4 multi-terminal (= 028 OQ-4) | **Defer to 028**; single-session-per-device inherited | ☐ acknowledge defer |
| OQ-5 transport | **Reuse `Authorization: Bearer`** + **new authz scheme ≠ 030's `operator-identity`** | ✅ ratify · acknowledge contract-phase scheme flag |

**Gate reminder:** ratifying these recommendations does **not** authorize dispatch. Dispatch still requires explicit scoped owner approval **+ G10 verification** against 028 §5/§6/§7 (spec.md §Dependencies). After ratification + G10, the owning repo's plan phase consumes this brief to author `plan.md`/`tasks.md`. The recommended-first D3 sequencing is already satisfied (029 shipped, PR #550).
