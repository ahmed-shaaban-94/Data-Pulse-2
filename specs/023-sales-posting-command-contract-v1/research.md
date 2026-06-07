# Phase 0 Research: Sales-Posting Command Contract v1

**Feature**: 023-sales-posting-command-contract-v1 | **Date**: 2026-06-07 | **Constitution**: v3.0.1

This document records the decisions, rationale, and rejected alternatives behind
the 023 planning spec. Each unknown surfaced in the spec is resolved here or
explicitly escalated.

---

## D-1 — Transport direction: connector-initiated command vs genuine DP2→connector push

**Decision**: **Connector-initiated** command — the connector calls a
DP2-exposed command endpoint, exactly as it calls the 012 feed. Genuine
DP2→connector push is **REJECTED for 023**. *(OQ-1 RESOLVED by the owner
2026-06-07 in favour of connector-initiated; this is no longer an open question.
See spec §10 / Clarifications Q6.)*

**Rationale**: The arc's load-bearing invariant — stated in the 012 contract
header, in 017, in `contract-obligations.md`, and rooted in §IX — is *"DP2 makes
NO outbound HTTP calls; it EXPOSES endpoints, the connector CALLS them."* The
connector holds the ERPNext credentials and is the only component that talks to
ERPNext. Genuine push would invert this: DP2 would make an outbound call to a
connector-hosted endpoint, requiring callback-URL registration, an egress
posture, mTLS/signing, and retry/backoff ownership on the DP2 side. None of that
was pre-authorized — the task pre-authorized re-speccing exactly one thing (the
Payment Entry deferral). Silently re-speccing a constitutional-adjacent invariant
by best-judgment is exactly the "inventing scope" the analyze step forbids.

**Alternatives considered**:
- *Genuine DP2→connector push (escalated as OQ-1; REJECTED by owner 2026-06-07).*
  Would need its own decision record + likely a separate spec; inverts §IX. Was
  escalated as the single human `[NEEDS CLARIFICATION]` and resolved against —
  out of scope for 023.
- *Connector-initiated long-poll / streaming channel (deferred).* A
  connector-opened channel down which DP2 streams commands preserves the
  invariant and feels "push-like," but adds streaming complexity with no
  confirmed need. Recorded as a possible future evolution, not v1.

---

## D-2 — Replace vs complement the 012 pull feed

**Decision**: **Complement** — additive, parallel, versioned. 023 never touches,
renames, or breaks the 012 feed operations.

**Rationale**: 015 is CLOSED and consumes 012 as a fixed contract; the whole
posting loop runs over the feed. §IV makes `operationId` renames and version
reuse breaking changes. 018 names 023 as "sales-posting command, *if needed*" — a
handoff option, not a migration. The constitution-safe reading is purely
additive: new `operationId`s under a new path segment, coexisting with the feed.

**Alternatives considered**:
- *Replace the feed (rejected).* Forces a breaking §IV change to a shipped
  surface and re-litigates 015; no benefit for the pilot.
- *Fold the command into `posting-feed.yaml` as extra operations (rejected).*
  Muddies the feed contract's single-transport identity; a separate
  `posting-command.yaml` keeps each transport reviewable in isolation and matches
  the one-file-per-concern convention.

---

## D-3 — Work-item payload shape

**Decision**: Mirror the 012 `PostingWorkItem` / `Sale` / `SaleLine` **verbatim**
(the curated 008 sale projection: header + frozen lines with DP2-resolved
`erpnextItemRef`, provenance, `businessDate`, `kind`, optional `reversalOf`).
Copy the schemas self-contained per file (the 010/008/012 convention), not
cross-`$ref`'d.

**Rationale**: A connector must post identically regardless of transport. Reusing
the exact 012 shapes guarantees a single dialect, satisfies O-1 (post without
reaching back into DP2) and O-6 (version-independence), and avoids accidental
divergence. The self-contained copy convention is already established across
`catalog/read-down.yaml`, `pos-sales/sales.yaml`, and `posting-feed.yaml`.

**Alternatives considered**:
- *Cross-`$ref` into `posting-feed.yaml` (rejected).* The non-recursive loader
  and the repo's per-file convention argue against cross-file `$ref`; copying is
  the established pattern.
- *A leaner command payload (rejected).* Trimming fields would break O-1 (the
  connector would have to fetch more) and diverge the dialect.

---

## D-4 — Outcome reporting & idempotency

**Decision**: Reuse the 012 `connectorAckOutcome` vocabulary verbatim —
`posted` (+ `documentRef`) / `failed_transient` / `permanently_rejected`
(+ structured `reason`), with a REQUIRED `Idempotency-Key` header reusing the
existing `IdempotencyInterceptor`. 200-replay (`Idempotent-Replayed: true`),
201-fresh, 409 `idempotency_key_conflict` on key-reuse-with-different-outcome;
duplicate `posted` echoes the existing `documentRef`.

**Rationale**: §XI + O-2/O-3 are non-negotiable; at-least-once delivery requires
the outcome report to be idempotent. The interceptor already exists; introducing
a new idempotency primitive would be unjustified drift. The return path is
non-optional — a command is not complete until DP2 records its outcome.

**Alternatives considered**:
- *A synchronous in-exchange outcome (rejected for v1).* Returning the outcome in
  the same HTTP response as the command fetch couples fetch and report and
  complicates retry semantics; a separate idempotent ack mirrors 012 and is
  retry-clean. (The implementation slice MAY still expose a combined convenience
  later; the contract keeps the ack discrete.)
- *A new idempotency mechanism (rejected).* Violates "no new primitive."

---

## D-5 — Posting-status / DLQ state ownership

**Decision**: 023 introduces **no new schema**. It reads/advances the existing
015 posting status and reuses the 017 DLQ + reconciliation surface. The immutable
008 sale fact is never mutated.

**Rationale**: §IX/§X immutable facts + the 017 READ-NOT-MIRROR / REPAIR-REUSES-
015-O3 discipline. A new posting-status table for a parallel transport would be a
gated drift with no justification and would risk two divergent status sources.

**Alternatives considered**:
- *A command-specific status table (rejected).* Two sources of posting truth is
  exactly the corruption §IX guards against.

---

## D-6 — Payment Entry / tender

**Decision**: The Payment Entry deferral (gate A.5) holds. The command work-item
carries the sale only; `posTotal` is the sale total, not tender. A future tender
extension is a versioned, backward-compatible addition.

**Rationale**: 008 models no tender; re-introducing it was not authorized. This
mirrors 012's explicit deferral verbatim and keeps the two transports aligned.

**Alternatives considered**:
- *Add tender now (rejected).* No source data (008), no authorization, would
  diverge from 012.

---

## D-7 — Error surface & version-independence

**Decision**: Reuse the canonical `Error` envelope verbatim. Closed `error.code`
set on the command surface: `validation_failure`, `idempotency_key_conflict`,
`not_found`, `system_failure` (plus the generic 401). **No `snapshot_required`**
(there is no cursor in a command transport). ERPNext documents addressed only by
the generic `doctype` + `name` shape (O-6); no schema names an ERPNext doctype
field.

**Rationale**: Consistency with `auth` / `outbox` / `pos-sales` / `posting-feed`;
`snapshot_required` is feed-cursor-specific and meaningless here, so dropping it
is correct, not an omission. O-6 keeps the contract insulated from ERPNext churn.

**Alternatives considered**:
- *Carry `snapshot_required` for symmetry (rejected).* It would be dead on a
  command surface and confuse reviewers.

---

## Open question escalated to the owner — RESOLVED

- **OQ-1 (genuine push vs connector-initiated command)** — see D-1.
  **RESOLVED 2026-06-07: connector-initiated; genuine push rejected for 023.**
  It was escalated because resolving it toward genuine push would invert §IX; the
  owner ruled in favour of the §IX-preserving connector-initiated model, so the
  invariant stands and the question is closed. No `[NEEDS CLARIFICATION]` remains.

## Provisional-need note

The pull feed is sufficient for the pilot. 023 is "if needed"; the concrete need
(low-latency single posting, operator "post now" repair, cursor-less connector
runtime) must be confirmed before the `[GATED]` 023-CONTRACT slice is authorized.
If no need materialises, 023 stays planning-only — a recorded option.
