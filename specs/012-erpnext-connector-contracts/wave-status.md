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
| `.specify/memory/decisions/0008-retail-tower-erpnext-connector-repo-split.md` | Connector split ADR | **Accepted 2026-06-04** |

> **Update 2026-06-04:** the 012 planning spec merged (PR #476), and **ADR 0008 is now Accepted** — the `Retail-Tower-ERP-Next-Connector` repo split is authorized.

### `[GATED]` 012-CONTRACT slice — MERGED (PR #481, `aad0cf9`)

| File | Purpose | State |
|---|---|---|
| `packages/contracts/openapi/erpnext-connector/posting-feed.yaml` | The DP2 ↔ connector OpenAPI contract: `connectorPullPostings` (GET cursor feed) + `connectorAckOutcome` (POST outcome ack); `connectorBearer` machine scheme; mirrored 008 sale payload; satisfies O-1..O-7 | **Merged** `[GATED]` |
| `apps/api/test/erpnext-connector/contract/posting-feed.contract.spec.ts` | Structural load-only conformance spec (28 assertions: operationId presence + global uniqueness, machine-bearer-not-clerkJwt, cursor/pagination, bidirectional GET+POST, idempotency, decimal money, strict DTOs, closed error set) | **Merged — 28/28 PASS** |

> The contract spec is load-only (no Docker/HTTP) and **passes 28/28**. Payment Entry tender is DEFERRED (008 carries no tender, gate A.5) — the work-item posts the Sales Invoice only until a DP2 payments model lands. Next: ERPNext-major staging validation, then build the connector repo against this contract.

---

## Merged on `main`

| Slice | Subject | PR / commit |
|---|---|---|
| 012 planning spec | spec + contract-obligations + connector-lifecycle + follow-up + wave-status | #476 |
| ADR 0008 | connector repo split — Accepted | #479 (`3dc56ff`) |
| `[GATED]` 012-CONTRACT | `posting-feed.yaml` OpenAPI contract + conformance spec (28/28) | **#481 (`aad0cf9`)** |

---

## Active findings

_None._

---

## Blocked

_None._ 012 planning, ADR 0008 acceptance, and the `[GATED]` 012-CONTRACT slice are
all **merged**. Downstream **gated/separate** follow-ups remain (not blockers): the
`erpnext.posting.requested` outbox event-type registration PR; any new ERPNext client
dependency (`[GATED]` `package.json`); the DP2-side feed/ack endpoint implementation
(015 + connector-feed).

---

## Proposed (awaiting approval)

- **013–017** — the rest of the ERPNext arc (each its own Spec-Kit chain).

_(ADR 0008 — connector repo split — is **Accepted** as of 2026-06-04. The `[GATED]` **012-CONTRACT** OpenAPI slice is **authored** in this PR — no longer awaiting approval.)_

---

## Next recommended action

012 planning (#476), ADR 0008 (#479), and the `[GATED]` 012-CONTRACT contract
(#481) are all **merged on `main`**. Remaining:
**(a)** confirm the final ERPNext major via staging-install validation of the
contract obligations (the version-pin gate deferred to 012);
**(b)** build the `Retail-Tower-ERP-Next-Connector` repo against the merged
`posting-feed.yaml` contract (+ add its upstream-decision-index pointer back to
the DP2 011/012 decisions);
**(c)** register the `erpnext.posting.requested` outbox event type (its own
approval PR) and implement the DP2-side feed/ack endpoints (015 + connector-feed).
Then **013 (product master)** can begin its own Spec-Kit chain.

---

## Closeout note (docs-only)

No application code, DB schema/migration, OpenAPI YAML, `package.json`/lockfile,
or CI changed. No connector code was added. **No runtime behavior changed.** The
PR adds `specs/012-erpnext-connector-contracts/` + the proposed ADR 0008 under
`.specify/memory/decisions/`.
