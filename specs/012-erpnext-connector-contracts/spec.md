# Feature Specification: ERPNext Connector Contracts

**Feature ID**: 012
**Short name**: erpnext-connector-contracts
**Feature Branch**: `feat/012-erpnext-connector-contracts`
**Created**: 2026-06-04
**Status**: Draft — **planning / docs only** (no code, no schema, no OpenAPI YAML, no connector code)
**Owner**: Ahmed Shaaban
**Depends on**: [011-erpnext-pos-reference-and-integration-foundation](../011-erpnext-pos-reference-and-integration-foundation/spec.md) — **all four decision records SIGNED** (gate SATISFIED), specifically the [posting decision](../011-erpnext-pos-reference-and-integration-foundation/decisions/posting-decision-record.md) and the [version-pin decision](../011-erpnext-pos-reference-and-integration-foundation/decisions/version-pin-upgrade-policy.md)
**Consumed by**: the future **Retail-Tower-ERP-Next-Connector** repo (custom Frappe app — does not exist yet; its creation is the split ADR this spec proposes), and the downstream specs 013–017
**Constitution version**: 3.0.1 — primary touchpoints §IV (Contract-First Integration / trust boundary), §IX (Source-of-Truth Model / provenance), §III (Backend Authority / money), §VIII (reproducible releases / `[GATED]`), §X (temporal semantics), §XI (idempotency / external IDs), §XII (object safety), §XIV (PII discipline)

**Input**: User description — define the **contract surface and connector lifecycle** between Data-Pulse-2 and ERPNext (via the future connector), realising the 011 posting + version-pin decisions, **without authoring the OpenAPI YAML** and **without building the connector**. Wire direction is **pull/feed** (owner decision 2026-06-04).

---

## Clarifications

### Session 2026-06-04

- Q: Is 012 a code feature or planning? → A: **Planning / docs only.** It produces a spec + the contract-obligation and connector-lifecycle planning docs + proposes the connector split ADR. It does **not** author the `[GATED]` OpenAPI YAML (a later slice, like 008-CONTRACT / 010-CONTRACT), does **not** build the connector, and does **not** implement posting (015). (Scope locked.)
- Q: Wire direction for work-items between DP2 and the connector? → A: **Pull/feed.** The connector authenticates to DP2 and **pulls** a feed of pending postings, posts to ERPNext, then **ACKs outcomes back** to DP2. DP2 stays **inbound-only** (it makes no outbound HTTP calls today; a push/webhook model would create a first-ever egress + credential-holding surface). This **reuses the just-shipped 010 read-down snapshot+delta + device/principal-auth machinery**. Push/webhook and shared-broker were considered and rejected for v1 (egress blast radius / shared infra). (Direction locked — see [connector-lifecycle.md](./connector-lifecycle.md).)
- Q: Is the contract one-way (work-items out) or bidirectional? → A: **Bidirectional.** Because 017-sync-ops/repair is a **DP2** spec that surfaces the DLQ + reconciliation state, the connector MUST report **every** posting outcome (ERPNext document reference, ETA status/UUID passthrough, success/failure/permanent-rejection) **back to DP2**. The outcome/return path is **non-optional** regardless of which direction carries the work-items. (Bidirectionality locked.)
- Q: Where does the connector repo split decision live? → A: As an **ADR** under `.specify/memory/decisions/` (the repo-wide ADR home, per [future-repo-split-criteria.md](../../docs/architecture/future-repo-split-criteria.md) "process for a split"), **not** in this spec's folder and **not** in 011's per-spec `decisions/` folder. 012 **proposes** it; acceptance is a separate owner act. (ADR home locked.)
- Q: Does 012 register a new outbox event type? → A: **No — it only names it.** Per the [outbox event-type registry](../../docs/outbox/event-types.md), adding an event type is a **separate approval PR**; it is not introduced as a side-effect. 012 names the intended posting event type as a forward reference; registration happens in its own gated PR when 015 needs it. (Event-type discipline locked.)

---

## 1. Background & Why

The 011 foundation established ERPNext as the reference ERP, fixed the integration boundaries (one path to ERPNext: **DP2 → connector → ERPNext**), and **signed four decisions**. Two of them gate 012:

- The **posting decision** fixed the *semantics* of how a DP2 sale becomes ERPNext accounting truth: **async**, outbox-driven, **one submitted Sales Invoice per sale**, `businessDate`-driven posting date, idempotent on `sourceSystem + externalId` + payload hash, **retry → DLQ + reconciliation flag** (DP2 sale fact never mutated), and **void/refund as a new reversing document**.
- The **version-pin decision** fixed that the connector talks to a **self-hosted, pinned** ERPNext (v15 reference-lab baseline; final major confirmed *here* in 012), the **connector absorbs ERPNext breaking changes**, and the **DP2 ↔ connector contract is insulated from ERPNext version churn**.

What 011 deliberately left open — and what 012 now fixes — is the **contract between DP2 and the connector**: the wire surface, the payloads that cross it, the connector's lifecycle and auth, and *who holds which credentials*. Without this contract, nothing downstream (013 product master, 014 inventory reconciliation, 015 sale posting, 016 tax/fiscal, 017 sync-ops) can be built, because they all cross this seam.

012 is **contract-first** (§IV): it specifies the **obligations** the eventual `[GATED]` OpenAPI contract must satisfy, so the connector repo and DP2 can be built against a stable, versioned boundary — but it does **not author the YAML** (that is a later gated slice) and does **not build the connector** (that is the connector repo's work, after its split ADR is accepted).

**Wire direction (owner decision):** **pull/feed.** The connector pulls pending postings from DP2 and ACKs outcomes back. DP2 stays inbound-only, reusing the 010 read-down + device-auth machinery. The contract is **bidirectional**: work-items flow out (DP2 → connector pulls), outcomes flow back (connector → DP2 ACK), because DP2 owns the DLQ/reconciliation state that 017 surfaces.

---

## 2. Goals

- Specify the **DP2 ↔ connector contract surface** as a set of **obligations** (see [contract-obligations.md](./contract-obligations.md)) that the eventual `[GATED]` OpenAPI YAML MUST satisfy — realising the signed posting decision over a **pull/feed** transport.
- Specify the **connector lifecycle** (see [connector-lifecycle.md](./connector-lifecycle.md)): authentication, credential ownership, the pull/ACK loop, retry/DLQ ownership, and the version-independence clause.
- Confirm the boundary invariant: the connector holds **all** ERPNext credentials; DP2 holds **none**; DP2 makes **no outbound HTTP calls** (it exposes a feed the connector pulls).
- Establish that the contract is **bidirectional** and that **DP2 owns the DLQ + reconciliation state** (the connector reports every outcome back; 017 surfaces it).
- **Propose the `Retail-Tower-ERP-Next-Connector` split ADR** under `.specify/memory/decisions/`, per the established split process — for separate owner acceptance.
- **Name** (not register) the intended posting outbox event type as a forward reference for 015.
- Confirm the **final ERPNext major version** target (the v15-baseline question the version-pin decision deferred to 012) — or document the staging-validation gate that confirms it.

---

## 3. Non-Goals

This feature is **planning / docs only**. It explicitly does **not**:

- Author **OpenAPI YAML** under `packages/contracts/openapi/**` — that is a separate `[GATED]` slice (the 012-CONTRACT analogue of 008-CONTRACT / 010-CONTRACT). 012-planning describes contract *obligations*; it does not write the contract.
- **Build the connector.** No custom Frappe app, no ERPNext client, no pull loop implementation. The connector lives in its own repo, created after the split ADR is accepted.
- Modify any **application code** (NestJS modules, services, controllers, workers).
- Modify any **DB schema or migration** (`packages/db/**`).
- **Register** a new outbox event type (a separate approval PR per [event-types.md](../../docs/outbox/event-types.md)) — 012 only *names* it.
- Modify **`package.json` / lockfiles / CI** (`.github/**`). A new ERPNext/Frappe client dependency is a separate `[GATED]` decision (per the version-pin decision).
- **Implement** posting (015), product master (013), inventory reconciliation (014), or tax/fiscal (016) — 012 fixes the seam they all cross, not their logic.
- Specify **ERPNext-internal APIs** — 012 owns the DP2 ↔ connector boundary; how the connector talks to ERPNext internally is the connector repo's concern (insulated from this contract per the version-pin decision).
- **Create** the `Retail-Tower-ERP-Next-Connector` repo or **accept** its split ADR — 012 only *proposes* the ADR.
- Change **runtime behavior** of any kind.

---

## 4. Actors

| Actor | Role in 012's contract |
|---|---|
| **Data-Pulse-2 (backend)** | Exposes the **pull feed** of pending postings (authenticated, scoped) and the **ACK/outcome ingest**. Owns the DLQ + reconciliation state. Makes **no outbound HTTP calls**; holds **no** ERPNext credentials. Source of truth for the sale fact. |
| **Retail-Tower-ERP-Next-Connector** *(future repo)* | The **pull client**. Authenticates to DP2, pulls pending postings, posts to ERPNext (a self-hosted pinned instance), and ACKs outcomes back (ERPNext doc ref + ETA status + success/failure). Holds **all** ERPNext credentials. Absorbs ERPNext version churn. |
| **ERPNext / Frappe** | The pinned ERP the connector posts to. **Not** a direct actor on the DP2 ↔ connector contract — reachable only behind the connector. |
| **Owner / Architect** | Accepts the split ADR and confirms the final ERPNext major version. No connector repo is created until the ADR is accepted. |

Cross-tenant isolation, non-disclosing errors, and audit obligations on the DP2 feed follow the same posture the 010 read-down API established (§II/§XII).

---

## 5. Contract surface (summary)

The full obligations are in [contract-obligations.md](./contract-obligations.md). In brief, the **pull/feed bidirectional** contract has two halves:

```
   ERPNext-bound work (DP2 → connector pulls)        Outcomes (connector → DP2 ACKs)
   ───────────────────────────────────────────       ─────────────────────────────────
   • pending postings feed (sale facts to post)       • ERPNext document reference
     - sale payload + sale_lines                       • ETA status / UUID passthrough
     - sourceSystem + externalId + payload hash         (when 016 ETA is live)
     - businessDate (drives posting_date)              • outcome: posted | failed |
   • reversal work (void/refund → reversing doc)         permanently-rejected (→ DLQ)
   • cursor/ack semantics (mirrors 010 delta)         • idempotency echo (same doc on retry)
```

**Invariant**: DP2 exposes; the connector pulls and reports back. One path to ERPNext; DP2 stays inbound-only.

---

## 6. The connector split ADR (proposed here)

012 **proposes** an ADR under `.specify/memory/decisions/` titled (working) *"Split Retail-Tower-ERP-Next-Connector from Data-Pulse-2"*, per the **process for a split** in [future-repo-split-criteria.md](../../docs/architecture/future-repo-split-criteria.md):

- **Boundary test met**: **security** (the connector holds ERPNext credentials — an isolation/blast-radius boundary a DP2 module cannot provide) and **team ownership** (connector roadmap + ERPNext-version upgrade cadence).
- **Contract surface**: the DP2 ↔ connector pull/feed contract specified here.
- **Data ownership**: connector owns ERPNext-facing state + credentials; DP2 owns the sale fact, the feed, and the DLQ/reconciliation state.

Acceptance of the ADR is a **separate owner act**. Until accepted, any DP2-side prototyping would start as a backend module (per feature-placement-rules.md), never as direct ERPNext calls from POS-Pulse or Console.

---

## 7. ERPNext version confirmation (deferred from version-pin)

The version-pin decision set **v15 as the reference-lab baseline** and **deferred the final supported major** to 012, "after connector contract tests, staging-install validation, and compatibility checks." 012 records the **gate**, not a premature lock: the final major (v15 vs v16, both extant by mid-2026) is confirmed by a **staging-install validation** of the contract obligations against the candidate major before the `[GATED]` OpenAPI slice is written. If validation passes on the baseline, v15 is confirmed; otherwise the gate selects the validated major. (See [connector-lifecycle.md](./connector-lifecycle.md) §version-independence.)

---

## 8. Acceptance Criteria

012 (this planning spec) is **complete** when:

1. **AC-1 — Spec exists** with Background, Goals, **Non-Goals (§3)**, Actors, contract-surface summary, the split-ADR proposal, and the version-confirmation gate.
2. **AC-2 — Contract obligations enumerated.** `contract-obligations.md` lists the obligations the eventual `[GATED]` OpenAPI YAML MUST satisfy (the seven below), without authoring the YAML.
3. **AC-3 — Connector lifecycle specified.** `connector-lifecycle.md` defines auth, credential ownership, the pull/ACK loop, retry/DLQ ownership, and the version-independence clause.
4. **AC-4 — Split ADR proposed** under `.specify/memory/decisions/` for separate owner acceptance.
5. **AC-5 — Forward references recorded.** `follow-up-notes.md` names (not registers) the posting outbox event type and points to 013–017.
6. **AC-6 — Docs-only.** No app code, DB schema/migration, OpenAPI YAML, `package.json`/lockfile, CI, or connector code; no runtime behavior change.

### Gated / separate follow-ups (NOT in this PR)

| Follow-up | Gate | Where |
|---|---|---|
| OpenAPI YAML for the DP2 ↔ connector contract | `[GATED]` `packages/contracts/openapi/**` | a later 012-CONTRACT slice |
| Connector repo creation | accepted split ADR | the new `Retail-Tower-ERP-Next-Connector` repo |
| Posting outbox event-type registration | separate approval PR | `docs/outbox/event-types.md` (when 015 needs it) |
| New ERPNext/Frappe client dependency | `[GATED]` `package.json` | the connector repo / a gated DP2 slice |

---

## 9. Closeout note

This is **planning / docs only**. After this PR: no code, no schema/migration, no OpenAPI YAML, no `package.json`/lockfile/CI, no connector code, and **no runtime behavior changed**. The deliverable is a spec + contract-obligation + connector-lifecycle planning docs + a proposed split ADR + forward-reference notes. The next steps are: **(a)** owner accepts the split ADR; **(b)** the `[GATED]` 012-CONTRACT slice authors the OpenAPI YAML; **(c)** the connector repo is created and built against it. See [wave-status.md](./wave-status.md) for the human-readable state.
