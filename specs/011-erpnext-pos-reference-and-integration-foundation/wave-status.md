# Wave Status — `011-erpnext-pos-reference-and-integration-foundation`

> Human-readable summary of where the spec stands. **011 is a docs-only
> foundation spec** — it has **no `execution-map.yaml` and no dispatchable
> code slices.** Its deliverable is a specification + four decision records +
> a follow-up map. **011 is CLOSED on `main`** (PR #468 + #472); the four
> decision records are **SIGNED** and the gate is **SATISFIED**. There is no
> remaining 011 move — the next DP2 work is downstream gated/separate (see
> "Next recommended action").

**Last updated:** 2026-06-04 by Ahmed Shaaban
**Spec:** `011-erpnext-pos-reference-and-integration-foundation` (`specs/011-erpnext-pos-reference-and-integration-foundation/`)
**Base:** `origin/main` at `80c4980`
**Status:** **CLOSED — merged on `main`** (PR #468 + PR #472)
**Active finding(s):** 0

---

## TL;DR

011 establishes **ERPNext/Frappe as the reference ERP** for Retail Tower OS, fixes the **integration boundaries** (POS-Pulse never calls Frappe directly; Retail-Tower-Console consumes Data-Pulse generated clients only; ERPNext POS is **reference-only**, never the production cashier), and stands up the **signed-decision gate** — four decision records (posting, stock impact, tax/fiscal Egypt v1, version pin) that **block** the downstream specs 012–017 until signed. This is **docs/spec only**: no code, no schema/migration, no OpenAPI YAML, no package/lockfile, no CI, no connector code, no runtime change.

**Status as of 2026-06-04 — 011 is CLOSED on `main`.** The foundation docs merged via **PR #468** (`3b9f598`, 2026-06-03) and the **four decision records are SIGNED** (owner Ahmed Shaaban) via **PR #472** (`f7a9ebd`, 2026-06-03) — the signed-decision gate is **SATISFIED** and 012–017 are unblocked. The downstream **012-erpnext-connector-contracts** arc has since moved well past planning: **012 planning spec merged** (PR #476, `3fb6e7d`), **ADR 0008 — connector repo split — Accepted** (PR #479, `3dc56ff`), and the **`[GATED]` 012-CONTRACT posting-feed OpenAPI** merged (PR #481, `aad0cf9`; closeout PR #482, `80c4980`). The remaining DP2 work is **downstream gated/separate** (not blocked by 011): ERPNext-major staging validation, the connector-repo build against `posting-feed.yaml`, the future `erpnext.posting.requested` outbox event-type registration, and the DP2-side feed/ack implementation (015 + connector-feed).

---

## Deliverables (docs-only)

| File | Purpose | State |
|---|---|---|
| `spec.md` | Foundation spec: goals, non-goals, actors, boundaries, numbering + connector decisions, follow-up map, acceptance criteria, signed-decision gate, closeout | Authored |
| `erpnext-pos-reference-map.md` | ERPNext POS ↔ Retail Tower OS concept map; ERPNext POS marked reference-only | Authored |
| `integration-boundaries.md` | Trust/ownership boundaries; one-path-to-ERPNext invariant | Authored |
| `decisions/posting-decision-record.md` | Posting model gate | **SIGNED 2026-06-03** |
| `decisions/stock-impact-decision-record.md` | Stock impact / valuation gate | **SIGNED 2026-06-03** |
| `decisions/tax-fiscal-egypt-decision-record.md` | Tax / fiscal (Egypt v1) gate | **SIGNED 2026-06-03** |
| `decisions/version-pin-upgrade-policy.md` | ERPNext/Frappe version pin & upgrade gate | **SIGNED 2026-06-03** |
| `follow-up-spec-map.md` | 012–017 sequence, dependencies, gating decisions | Authored |
| `wave-status.md` | This file | Authored |

Plus a one-line erratum pointer added to `docs/ROADMAP-ERP.md` (the only file touched outside this spec folder).

---

## Merged on `main`

| Slice | Subject | PR / commit | Merged |
|---|---|---|---|
| `011-FOUNDATION` (docs) | Foundation spec + ERPNext-POS reference map + integration boundaries + four decision-record placeholders + follow-up-spec-map + `docs/ROADMAP-ERP.md` erratum | **#468** (`3b9f598`) | 2026-06-03 |
| `011-SIGN-DECISIONS` (docs) | Sign the four ERPNext integration decision records (posting, stock impact, tax/fiscal Egypt v1, version pin) → **SIGNED**; gate **SATISFIED** | **#472** (`f7a9ebd`) | 2026-06-03 |

Both PRs are merged on `main`; the full 011 spec folder is present on `origin/main`. 011 is **CLOSED**.

---

## Local only — committed/uncommitted, not on `main`

_None._ All 011 deliverables are merged on `main` (see above).

---

## Active findings

_None._

---

## Blocked

| Spec | Blocked by | Notes |
|---|---|---|
| _None_ | — | The signed-decisions gate is **SATISFIED** (all four records SIGNED 2026-06-03). 012–017 are unblocked to begin their own planning chains. Each still runs its own Spec-Kit + Agent OS gates before any code. |

---

## Ready / approved — next to dispatch

_None (docs-only foundation; no code slices)._

---

## Proposed (awaiting approval)

The signed-decision gate is **SATISFIED**, so the 012–017 arc is no longer blocked by 011 (see [follow-up-spec-map.md](./follow-up-spec-map.md)):

- **012-erpnext-connector-contracts** — **no longer proposed; already merged.** Planning spec (PR #476), ADR 0008 connector repo split — Accepted (PR #479), and the `[GATED]` 012-CONTRACT posting-feed OpenAPI (PR #481, closeout #482) are all on `main`. See `specs/012-erpnext-connector-contracts/wave-status.md`.
- **013–017** — still proposed; each runs its own Spec-Kit + Agent OS chain when dispatched. None are blocked by 011 (its gate is satisfied); they sequence behind 012's contract surface per the follow-up map.

---

## Next recommended action

**011 is CLOSED** (PR #468 + #472 merged; four decision records **SIGNED**; gate **SATISFIED**), and the immediate downstream — **012 planning (PR #476), ADR 0008 (PR #479), and the `[GATED]` 012-CONTRACT posting-feed OpenAPI (PR #481, closeout #482)** — is **also merged on `main`**. Nothing in 011 itself remains to dispatch.

The next DP2 work is **downstream gated/separate** (none of it blocked by 011), per `specs/012-erpnext-connector-contracts/wave-status.md`:

1. **ERPNext-major staging validation** — confirm the final ERPNext major by installing it and validating the 012 contract obligations against it (the version-pin gate deferred into 012).
2. **Connector-repo build** — stand up `Retail-Tower-ERP-Next-Connector` (ADR 0008 — Accepted) against the merged `packages/contracts/openapi/erpnext-connector/posting-feed.yaml`, with an upstream-decision-index pointer back to the DP2 011/012 decisions. This is **a separate repo**, not DP2 work.
3. **`erpnext.posting.requested` outbox event-type registration** — a future DP2 change on its **own `[GATED]` approval PR** (named, not yet registered).
4. **DP2-side feed/ack implementation** — the `connectorPullPostings` / `connectorAckOutcome` endpoints land in **015 + connector-feed**, each its own Spec-Kit chain.

Then **013 (product master)** and the rest of the 013–017 arc can begin their own Spec-Kit chains.

---

## Closeout note (docs-only)

No application code, DB schema/migration, OpenAPI YAML, `package.json`/lockfile, or CI changed. No connector code was added. **No runtime behavior changed.** The merged PRs (#468 + #472) add the `specs/011-…/` documentation set (spec, reference map, integration boundaries, four decision records, follow-up-spec-map, this wave-status) plus a one-line erratum pointer in `docs/ROADMAP-ERP.md`, and nothing else. **011 is CLOSED.**
