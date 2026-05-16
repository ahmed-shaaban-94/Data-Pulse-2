# SDK Strategy — 004 Platform Production Readiness, Track E

| Field | Value |
|---|---|
| Ref | 004-platform-production-readiness (T620–T625) |
| Status | Draft — Phase 8 design lock-in (docs only, NO SDK files generated in this repo) |
| Constitution | v3.0.0 (esp. §IV Contract-First POS Integration, §VIII Reproducible & Versioned Releases) |
| Date | 2026-05-16 |
| Cross-references | spec §1.5 Q3, spec §10, plan §3.5, research §5, research §6, tasks.md §11 |

---

## 1. Lock-in (T620)

- **Generated types**: `openapi-typescript`
- **Typed client**: `openapi-fetch`

### Rationale (per research §5)

- Tree-shake friendly; no runtime overhead beyond a small `fetch` wrapper.
- Generated types are pure structural — no class hierarchy, no runtime classes,
  no Zod boundary on the client side. The server already validates with Zod at
  its own boundary; duplicating that on the client would add weight without
  improving safety.
- Compatible across the three consumer environments we care about:
  - React Native (POS app, separate repo)
  - Next.js / browser (dashboard, separate repo / future feature)
  - Node.js 20 (server-to-server, operator tooling)
- Both libraries are maintained inside the same OpenAPI-TypeScript ecosystem
  (`openapi-typescript` family), reducing toolchain fragmentation.
- Output is a single `.ts` file of types plus a single small runtime — easy to
  pin, easy to diff, easy to audit in review.

### Q3 confirmation

Locked by spec §1.5 Q3 ("Generated types via `openapi-typescript` plus typed
client via `openapi-fetch`"). Not revisitable in this slice; any change would
require a new clarification round and amendment of the spec.

---

## 2. Rejected alternatives (T620)

| Tool | Why considered | Why rejected |
|---|---|---|
| `orval` | Mature; React Query integration | Heavy runtime; opinionated React-hook generation; harder to use in POS RN / Node server contexts; couples consumer code to the React Query lifecycle. |
| `openapi-generator` (Java-based) | Multi-language coverage | JVM dependency in toolchain; mutable generated output that invites hand-edits; harder to lint/diff cleanly; obvious code smell for an otherwise TS-only project. |
| `@hey-api/openapi-ts` | Strong typing | Less stable ecosystem at the time of lock-in; fewer downstream consumers in the relevant runtimes; team unfamiliarity outweighs marginal type-quality differences. |
| Hand-written client | Full control | Drift against OpenAPI is the entire problem this track exists to solve; rejected by definition. |

---

## 3. Output locations (T621)

| Location | Eligible for first slice? | Notes |
|---|---|---|
| Outside this repo (operator-side tooling) | Yes | Operators run codegen locally and pin the result inside their own repo. |
| Dashboard repo | Yes | Dashboard team owns its own client; runs codegen in its CI. |
| POS repo | Yes | POS team owns its own client; runs codegen in its CI. |
| Internal `packages/sdk` in this repo | NOT eligible | FR-E-007: forbidden in first slice. Re-evaluated only after the dashboard and POS contract surfaces stabilize. |

The default first-slice mechanism is **downstream-repo CI runs the generator**
against pinned OpenAPI source from this repo (research §6). This repo
publishes the contracts; it does not publish a generated SDK.

---

## 4. Drift detection (T622)

- **Mechanism**: each downstream repo's CI runs `openapi-typescript` against
  the latest pinned OpenAPI source and `git diff`s the generated output
  against the committed one.
- A non-empty diff in CI = drift → a downstream PR is opened (manually or by
  bot) to regenerate.
- **In-repo drift-detection CI is deferred** (T641, gated behind a separate
  decision). Rationale (research §6): downstream owners already need the
  regeneration step in their own CI to ship safely, so duplicating it inside
  this repo adds maintenance cost without catching issues earlier in the
  consumer's release path. We revisit if downstream signals show the
  duplication would have value.

---

## 5. Generated-file policy (T623)

- Generated artifacts MUST NOT be hand-edited (FR-E-005). Hand-edits create
  silent contract drift and undermine the regenerate-and-diff loop.
- Regeneration MUST be deterministic — same OpenAPI source + same toolchain
  version = byte-identical output. Non-determinism is treated as a bug in the
  generator pinning, not as expected behavior.
- Fixes flow only through `packages/contracts/openapi/*.yaml`. Generated files
  are derivatives, not source. A bug in a generated client is a bug in the
  contract or in the generator version.
- Each downstream repo SHOULD pin both `openapi-typescript` and `openapi-fetch`
  versions, and treat upgrades to either as reviewable PRs (the generated
  output diff is part of the review).

---

## 6. Header expectations for the generated client (T624)

The generated client MUST handle these headers correctly. Defaults are
deliberately conservative — the SDK exposes options; it does not generate
behaviour on the caller's behalf.

| Header | Source | Purpose | Notes |
|---|---|---|---|
| `Authorization: Bearer <token>` | Foundation 001 auth | Authenticated calls. | Refreshed via `POST /api/v1/auth/refresh`. The SDK MUST NOT replay an expired token on retry; it MAY call a configurable refresh callback once (see §7). |
| `Idempotency-Key` | Track D | Retry safety for mutating calls. | See `docs/idempotency/strategy.md`. SDK SHOULD expose a per-call option. SDK MUST NOT auto-generate keys — the application owns key generation intent. |
| `X-Tenant-Id` | Foundation 001 (`POST /api/v1/context/tenant` establishes; some flows allow header override per OpenAPI) | Tenant context for cross-tenant flows. | SDK should expose as an explicit per-call option, not as automatic state derived from a global. |
| `X-Store-Id` | Foundation 001 | Store scoping where applicable. | Same as `X-Tenant-Id`. |
| `Idempotent-Replayed: true` (response) | Track D | Marks a replayed response. | SDK SHOULD surface this in a result envelope so callers can distinguish a fresh execution from an idempotent replay. |
| `Retry-After` (response) | HTTP standard, used on 425 | Client retry pacing. | SDK SHOULD honor this on the 425 path; see `docs/idempotency/strategy.md` §8. |

---

## 7. 425 / 409 / 401 handling in the generated client

- **`425 Too Early`**: SDK SHOULD provide an opt-in automatic retry that honors
  `Retry-After`. Default: opt-in only — the caller decides.
- **`409 Conflict` (idempotency)**: terminal. SDK MUST NOT auto-retry. The
  uniform error envelope is returned to the caller verbatim.
- **`401 Unauthorized`**: SDK MAY call a configurable token-refresh callback
  once; if the call still returns `401`, the error envelope is returned to the
  caller. SDK MUST NOT loop on refresh.
- **`5xx`**: terminal by default. Auto-retry is opt-in only; the caller is the
  source of truth for retry intent on server errors.

---

## 8. Cross-reference

- Spec §10 (Track E) — the user-facing acceptance criteria these decisions
  satisfy.
- Plan §3.5 / §3.5.2 — output locations and deferral of `packages/sdk`.
- Research §5 — full alternatives analysis.
- Research §6 — drift-detection design space.
- Tasks.md §11 — T620–T625 deliverables expanded above.
