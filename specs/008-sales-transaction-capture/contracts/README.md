# Phase 1 Contract Design: Sales / Transaction Capture (008)

**Plan**: [../plan.md](../plan.md) | **Spec**: [../spec.md](../spec.md)

> **This file is DESIGN, not the contract.** The OpenAPI contract-of-record for 008 lives under `packages/contracts/openapi/**` and is a **`[GATED]`** artifact (Constitution §IV/§VIII, Standing Rules §3) — it is **NOT created by `/speckit-plan`** and is **NOT created in this directory**. It is its own approval-gated slice (plan §3.2, §8). This README records the *operations the contract will need* and the *conventions it must follow*, **without copying field shapes** (reference-only, like the console's no-copy rule). No path strings, status codes, or JSON field names are fixed here — those are the `[GATED]` slice's job.

---

## Operations the 008 contract will expose (capabilities, not paths)

All are POS-facing (`/api/pos/v1/...`, POS-device-token auth), mirroring the shipped `posCaptureItem` pattern. Each carries a stable `operationId` (renames are breaking, §IV).

| Capability | Behavioral contract | Spec FRs |
|---|---|---|
| **Capture sale** | Accept a completed sale (header + lines); create the immutable `sales` + `sale_lines` snapshot; preserve POS totals verbatim; dedup on `sourceSystem + externalId`; retain provenance; return a stable sale reference. | FR-001..005, FR-030, FR-040, FR-050 |
| **Record void** | Create a void terminal event referencing a sale; stamp `voidedAt`; never mutate the original; idempotent re-delivery. | FR-010/011/013/014 |
| **Record refund** | Create a refund terminal event referencing a sale; stamp `refundedAt`; preserve POS refund amount; idempotent. | FR-010/012/013/014 |
| **Read sale by reference** | The minimal authorized read needed to resolve a sale for void/refund and for duplicate-replay; object-level authz; safe-404 cross-tenant. | FR-014, FR-063, FR-100 |

## Inherited wire conventions (so the `[GATED]` slice doesn't reinvent)

From `packages/contracts/openapi/` (esp. `catalog/unknown-items.yaml`, `pos-*.yaml`) + `packages/contracts/README.md`:

- **POS auth**: the POS-namespace security scheme used by the `pos-*` contracts (per-device credential), as for `posCaptureItem` — **not** the dashboard `cookieAuth`.
- **Stable `operationId`** per operation; renames are breaking changes (§IV).
- **Uniform error envelope**: `{ "error": { "code", "message", "request_id", "details"? } }`; canonical status mapping (400/401/403/404/409/429/5xx). Cross-tenant = 404 (§II/§XII).
- **No raw DB entities** in responses — every body is an explicit `toBody()` wire projection decoupled from the schema (§IV). The `sales`/`sale_lines` DB shape is **never** returned directly.
- **Idempotency**: write operations honor the `Idempotency-Key` header reusing 001/005's mechanism (FR-051) — no new primitive.
- **Version label**: follow the repo-wide `*-draft` version convention.

## FR-101 failure category set the contract must encode

The contract's error vocabulary must distinguish at least: **validation-failure**, **not-found** (cross-tenant/out-of-scope, non-disclosing), **idempotency-token-mismatch** (per 005 FR-021c, distinct from a duplicate), **already-applied** (re-delivered terminal event), **conflict**, **system-failure**. The concrete transport encoding is the `[GATED]` slice's decision (FR-101).

## What this design explicitly does NOT do

- It does **not** author any `.yaml` under `packages/contracts/openapi/**` (that is the `[GATED]` contract slice).
- It does **not** fix path strings, HTTP methods, status codes, header names, or JSON field names.
- It does **not** copy field shapes from existing contracts — references by operation/convention only.
- It does **not** model tender/payment operations (deferred to 010, gate A.5).
