# Wave Status — `012-erpnext-connector-contracts`

> Human-readable summary. **012 is a planning / docs-only spec** — it has **no
> `execution-map.yaml` and no dispatchable code slices.** Its deliverable is a
> spec + contract-obligation + connector-lifecycle docs + a proposed split ADR +
> forward-reference notes. The next moves are owner acts (accept ADR 0008) and a
> later `[GATED]` contract slice — not a code dispatch.

**Last updated:** 2026-06-04 by Ahmed Shaaban
**Spec:** `012-erpnext-connector-contracts` (`specs/012-erpnext-connector-contracts/`)
**Base:** `origin/main` at `04c93a3`
**Active finding(s):** 0

---

## TL;DR

012 specifies the **DP2 ↔ connector contract surface + connector lifecycle**,
realising the signed 011 **posting** + **version-pin** decisions over a
**pull/feed bidirectional** transport (owner decision 2026-06-04: connector pulls
pending postings from DP2 + ACKs outcomes back; DP2 stays inbound-only, reusing
the 010 read-down + device-auth machinery). It enumerates **seven contract
obligations** (without authoring the OpenAPI YAML), specifies the connector
lifecycle (auth, credential ownership, pull/ACK loop, DP2-owned DLQ,
version-independence), and **proposes ADR 0008** to split the
`Retail-Tower-ERP-Next-Connector` repo. **Planning / docs only**: no code, schema,
migration, OpenAPI YAML, package/lockfile, CI, or connector code; no runtime
change.

---

## Deliverables (docs-only)

| File | Purpose | State |
|---|---|---|
| `spec.md` | Feature spec: goals, non-goals, actors, contract surface, split-ADR proposal, version gate, acceptance criteria | Authored |
| `contract-obligations.md` | The 7 obligations the `[GATED]` OpenAPI YAML must satisfy | Authored |
| `connector-lifecycle.md` | Auth, credential ownership, pull/ACK loop, DLQ ownership, version-independence | Authored |
| `follow-up-notes.md` | Named (not registered) outbox event type + 013–017 feed map | Authored |
| `wave-status.md` | This file | Authored |
| `.specify/memory/decisions/0008-retail-tower-erpnext-connector-repo-split.md` | Proposed connector split ADR | **Proposed** |

---

## Merged on `main`

_None._ (Awaiting review; nothing committed/pushed yet.)

---

## Active findings

_None._

---

## Blocked

_None._ 012 planning is unblocked (011 gate SATISFIED). Downstream **gated/separate**
follow-ups (not blockers on this PR): the `[GATED]` 012-CONTRACT OpenAPI slice; ADR
0008 acceptance; the `erpnext.posting.requested` registration PR; any new ERPNext
client dependency (`[GATED]` `package.json`).

---

## Proposed (awaiting approval)

- **ADR 0008** — split the `Retail-Tower-ERP-Next-Connector` repo (owner acceptance).
- The `[GATED]` **012-CONTRACT** slice — authors the OpenAPI YAML for the pull/feed contract.
- **013–017** — the rest of the ERPNext arc (each its own Spec-Kit chain).

---

## Next recommended action

After review/merge of this planning spec: **(a)** owner accepts **ADR 0008**;
**(b)** dispatch the `[GATED]` **012-CONTRACT** slice to author the OpenAPI YAML
for the DP2 ↔ connector pull/feed contract (the 008-CONTRACT / 010-CONTRACT
analogue); **(c)** confirm the final ERPNext major via staging-install validation
of the contract obligations (the version-pin gate deferred to 012); **(d)** create
the connector repo and build it against the contract. Then 013 (product master)
can begin.

---

## Closeout note (docs-only)

No application code, DB schema/migration, OpenAPI YAML, `package.json`/lockfile,
or CI changed. No connector code was added. **No runtime behavior changed.** The
PR adds `specs/012-erpnext-connector-contracts/` + the proposed ADR 0008 under
`.specify/memory/decisions/`.
