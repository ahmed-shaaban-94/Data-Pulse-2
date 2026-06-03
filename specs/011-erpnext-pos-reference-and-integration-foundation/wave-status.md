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

011 establishes **ERPNext/Frappe as the reference ERP** for Retail Tower OS, fixes the **integration boundaries** (POS-Pulse never calls Frappe directly; Retail-Tower-Console consumes Data-Pulse generated clients only; ERPNext POS is **reference-only**, never the production cashier), and stands up the **signed-decision gate** — four decision records (posting, stock impact, tax/fiscal Egypt v1, version pin) that **block** the downstream specs 012–017 until signed. This is **docs/spec only**: no code, no schema/migration, no OpenAPI YAML, no package/lockfile, no CI, no connector code, no runtime change. The next move is the **owner signs the four decision records**; then 012 may be planned.

---

## Deliverables (docs-only)

| File | Purpose | State |
|---|---|---|
| `spec.md` | Foundation spec: goals, non-goals, actors, boundaries, numbering + connector decisions, follow-up map, acceptance criteria, signed-decision gate, closeout | Authored |
| `erpnext-pos-reference-map.md` | ERPNext POS ↔ Retail Tower OS concept map; ERPNext POS marked reference-only | Authored |
| `integration-boundaries.md` | Trust/ownership boundaries; one-path-to-ERPNext invariant | Authored |
| `decisions/posting-decision-record.md` | Posting model gate | **UNSIGNED** |
| `decisions/stock-impact-decision-record.md` | Stock impact / valuation gate | **UNSIGNED** |
| `decisions/tax-fiscal-egypt-decision-record.md` | Tax / fiscal (Egypt v1) gate | **UNSIGNED** |
| `decisions/version-pin-upgrade-policy.md` | ERPNext/Frappe version pin & upgrade gate | **UNSIGNED** |
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
| 012–017 | The four `decisions/` records being `UNSIGNED` | Per spec §9 the signed-decisions gate is a hard stop on all downstream ERPNext specs. |

---

## Ready / approved — next to dispatch

_None (docs-only foundation; no code slices)._

---

## Proposed (awaiting approval)

The 012–017 ERPNext integration arc (see [follow-up-spec-map.md](./follow-up-spec-map.md)). All proposed, none green-lit; each blocked by its gating decision record(s).

---

## Next recommended action

**Owner signs the four decision records** in [decisions/](./decisions/) (posting, stock impact, tax/fiscal, version pin). Each is signed by setting `Status: SIGNED` with a dated owner sign-off and recording the chosen option. Once all four are signed, **012-erpnext-connector-contracts** may begin its Spec-Kit planning chain (and, within it, the `Retail-Tower-ERPNext-Connector` split ADR per `future-repo-split-criteria.md`). Until then, no ERPNext integration code may be written.

---

## Closeout note (docs-only)

No application code, DB schema/migration, OpenAPI YAML, `package.json`/lockfile, or CI changed. No connector code was added. **No runtime behavior changed.** The PR adds the `specs/011-…/` documentation set and a one-line erratum pointer in `docs/ROADMAP-ERP.md`, and nothing else.
