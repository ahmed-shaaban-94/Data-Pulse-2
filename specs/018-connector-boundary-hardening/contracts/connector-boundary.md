# Connector Boundary of Record — DP2 ↔ ERPNext Connector

**Phase 1 contract artifact (FR-023/024).** This documents the **existing** connector posting boundary and fixes future-surface ownership. It **does not redesign** the 012 feed/ack contract — that contract (`packages/contracts/openapi/erpnext-connector/posting-feed.yaml`) remains the machine source of truth. 018 tightens *access* to this boundary (identity, credential lifecycle, guard) without changing its shape.

## 1. The existing posting boundary (documented, not changed)

**Transport:** the connector PULLs pending sale work-items and POSTs typed outcome acks over a fixed surface.

| Aspect | Rule of record |
|---|---|
| **Namespace** | `/api/connector/v1/erpnext/postings` (feed: `GET`), `/api/connector/v1/erpnext/postings/{workItemRef}/outcome` (ack: `POST`). |
| **Authentication** | Machine `connector` bearer only (`connectorBearer`). After 018: the credential MUST be active, non-expired, non-revoked, **linked to a non-disabled `connector_registration` for the credential's tenant**. Human sessions, POS, and POS-operator credentials are rejected. |
| **Tenant scope** | Derived from the credential's own identity (the registration's tenant), **never** the request body/query (§XII / FR-018). |
| **Idempotency** | `connectorAckOutcome` REQUIRES an `Idempotency-Key`. The feed pull is a pure read (cursor-paged, `limit` 1..500, default 100). |
| **Replay** | A replayed ack returns success (`200 replayed`) with the same recorded outcome — no double effect, no second document. |
| **Error envelope** | Canonical `{ error: { code, message, request_id, details? } }` (§III); status per the canonical mapping; `request_id` always present. |
| **Non-disclosure** | Auth failures + foreign/cross-tenant refs return a uniform non-disclosing rejection — never revealing which condition failed or whether a resource exists (§II). |
| **Payload discipline** | No raw secret, no PII, no monetary data on the credentialing surface (§XIV / FR-022). The work-item payload itself is the 012 sale projection (governed by 012/015, out of 018 scope). |
| **Outbound** | DP2 makes NO outbound ERPNext HTTP. The connector is the only ERPNext-calling component (ADR 0008). |

**018 changes here:** only the **Authentication** row is tightened (registration linkage + the full usability predicate + identity attachment). Everything else is restated as-is.

## 2. Surface ownership (the A–E table)

What belongs to which spec — so neither DP2 nor the connector drifts scope.

| | Surface | Owner | Status |
|---|---|---|---|
| **A** | Posting feed/ack (`connectorPullPostings` / `connectorAckOutcome`) | DP2 — 012 contract / 015 impl | **Shipped.** 018 documents it + tightens its auth; does not redesign it. |
| **B** | Connector health / status (last-seen, lag, heartbeat → DP2) | DP2 — **020** (future) | References `connector_registration.id`. Out of 018. |
| **C** | Live ERPNext-Bin stock view (connector → DP2) | DP2 — **019** (future `[GATED]`) | **019 IS the contract 017 deferred as `017-STOCK-VIEW-CONTRACT`** — one identity. Authorizes by `connector_registration`. Out of 018. |
| **D** | Sales-posting command contract | DP2 — **023** (future, only if a gap over A is proven) | Reuses the 018 identity boundary. Out of 018. |
| **E** | Tax / fiscal (ETA passthrough, item tax templates) | DP2 — **016** (on hold) + the connector's ERP-side adapter | Deferred. Out of 018. |
| **—** | Scheduled reconciliation runs | DP2 — **029** (= 017's `017-SCHEDULED-RUNS`) | Out of 018. |
| **—** | Connector-side counterpart (consumes this boundary) | **Connector repo** spec (likely its 007) | Authored after 018, never before. |

## 3. What 018 adds (the identity boundary)

- **`connector_registration`** — stable per-tenant connector-instance identity (display name, ERPNext site ref, environment), unique on `(tenant, environment, site_ref)`. The thing B/C/D authorize against.
- **Credential lifecycle** — operator issue / rotate (atomic, immediate-revoke, at-most-one-active) / revoke; instance disable (logical). Raw secret shown once, never stored recoverably or logged.
- **Guard** — resolves the registration link + the full usability predicate; attaches the calling instance identity; non-disclosing on any failure; dashboard/POS path untouched.
- **Audit + signal** — every lifecycle action audited in-transaction (no secret) + an unlabeled lifecycle counter.

> The machine contract for the admin surface (if exposed as REST) is authored as a `[GATED]` OpenAPI under `packages/contracts/openapi/` at task time (gate pre-approved 2026-06-06). This document is the human boundary-of-record; it is not itself the machine contract for surface A (that stays `posting-feed.yaml`).
