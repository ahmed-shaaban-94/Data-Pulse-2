# Wave Status — `011-erpnext-pos-reference-and-integration-foundation`

> Human-readable summary of where the spec stands. **011 is a docs-only
> foundation spec** — it has **no `execution-map.yaml` and no dispatchable
> code slices.** Its deliverable is a specification + four decision-record
> placeholders + a follow-up map. The "next move" is an owner act (sign the
> decisions), not a slice dispatch.

**Last updated:** 2026-06-03 by Ahmed Shaaban
**Spec:** `011-erpnext-pos-reference-and-integration-foundation` (`specs/011-erpnext-pos-reference-and-integration-foundation/`)
**Base:** `origin/main` at `3bfdd7c`
**Active finding(s):** 0

---

## TL;DR

011 establishes **ERPNext/Frappe as the reference ERP** for Retail Tower OS, fixes the **integration boundaries** (POS-Pulse never calls Frappe directly; Retail-Tower-Console consumes Data-Pulse generated clients only; ERPNext POS is **reference-only**, never the production cashier), and stands up the **signed-decision gate** — four decision records (posting, stock impact, tax/fiscal Egypt v1, version pin) that **block** the downstream specs 012–017 until signed. This is **docs/spec only**: no code, no schema/migration, no OpenAPI YAML, no package/lockfile, no CI, no connector code, no runtime change. **Update 2026-06-03:** the foundation PR (#468) merged, and the **four decision records are now SIGNED** (owner Ahmed Shaaban) — the gate is **SATISFIED** and 012–017 are unblocked. The next move is to **plan 012-erpnext-connector-contracts** (consistent with the posting + version-pin decisions).

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

_None._ (Not committed or pushed; awaiting review per the brief's stop condition.)

---

## Local only — committed/uncommitted, not on `main`

| Slice ID | Branch | Commit | Notes |
|---|---|---|---|
| `011-FOUNDATION` (docs) | `feat/011-erpnext-pos-reference-and-integration-foundation` | _(uncommitted)_ | Authored in an isolated worktree off `origin/main@3bfdd7c`; no commit made (brief stop condition). |

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

The 012–017 ERPNext integration arc (see [follow-up-spec-map.md](./follow-up-spec-map.md)). All proposed, none green-lit; each blocked by its gating decision record(s).

---

## Next recommended action

The four decision records are **SIGNED** (2026-06-03) — the gate is **SATISFIED**. The next move is to **plan `012-erpnext-connector-contracts`**: begin its Spec-Kit planning chain (`spec.md` → `plan.md` → Constitution Check → `[GATED]` OpenAPI contract → `tasks.md` → `execution-map.yaml`) and, within it, propose the `Retail-Tower-ERP-Next-Connector` split ADR per `future-repo-split-criteria.md`. 012 must respect the **posting** decision (async outbox posting; one submitted Sales Invoice per sale; reversing documents) and the **version-pin** decision (ERPNext v15 self-hosted; DP2↔connector contract insulated from ERPNext churn; any new dependency a separate `[GATED]` call).

---

## Closeout note (docs-only)

No application code, DB schema/migration, OpenAPI YAML, `package.json`/lockfile, or CI changed. No connector code was added. **No runtime behavior changed.** The PR adds the `specs/011-…/` documentation set and a one-line erratum pointer in `docs/ROADMAP-ERP.md`, and nothing else.
