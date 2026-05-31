# Quickstart: Inventory & Stock Movement Ledger (009)

**Plan**: [plan.md](./plan.md) | **Spec**: [spec.md](./spec.md)

**This is a planning/validation workflow, not a runtime runbook.** 009 implementation is gated; nothing here runs production code. It is the checklist a slice author/reviewer walks before and during each implementing slice.

---

## 0. Bootstrap (every agent session)

1. `git fetch origin && git pull --ff-only origin main`.
2. Read `.specify/memory/constitution.md` (v3.0.1), `docs/agent-os/standing-rules.md`, the 009 `spec.md` + `plan.md` + `data-model.md` + `contracts/README.md`.
3. Confirm current state via GitHub (open PRs, recent commits) — do not trust chat memory for slice state.

## 1. Pre-flight per slice (Working Agreement)

- Quote the exact task text from `tasks.md` (after `/speckit-tasks` runs) and the relevant `contracts/README.md` operation.
- Confirm or update the Architecture Impact Map (plan §3).
- For a `[GATED]` slice (OpenAPI / `0014` migration / `package.json`): confirm explicit approval is recorded in the task before authoring.

## 2. The five resolved decisions (do not re-litigate — spec §Clarifications)

1. Negative stock = **allow and flag** (+ new negative-balance signal). Never reject outbound for going negative.
2. Quantity = **exact-decimal in the product's single stocking unit**; cross-unit **rejected**; no conversion engine.
3. Void/refund → restock = **manual/backfill provenance-linked inbound**; automatic deferred.
4. Product identity = **Tenant Catalog product**; ad-hoc = **nullable provenance**; **no auto-create**.
5. Idempotency = **`Idempotency-Key`** (manual) / **`sourceSystem+externalId`+sale-ref** (backfill).

## 3. The decoupling invariant (verify on every flow — SC-002)

- Movements never subscribe to `sale.captured`. The sale-linked backfill reads **captured** 008 `sales`/`sale_lines` rows (R8), never `processed_at`-stamped ones.
- **Test**: exercise every US1–US6 flow with the 008 live loop unwired (`processed_at` NULL) and assert success.

## 4. Validation contract per slice (RED → GREEN)

For each implementing slice, the test suite MUST cover:

- **On-hand correctness (SC-001)**: derived SUM == listed movements; empty key ⇒ deterministic zero (FR-005).
- **Append-only (FR-001)**: no UPDATE/DELETE path; corrections/restocks are new movements.
- **Idempotency (SC-003)**: replay same key ⇒ one movement; divergent body ⇒ conflict; re-run backfill converges (FR-033).
- **Allow-and-flag (FR-024)**: outbound below zero ⇒ success + negative-balance flag + counter increment; never rejected.
- **Cross-unit rejection (FR-022)**: a movement whose unit ≠ the product's stocking unit ⇒ 400.
- **Transfer linkage (SC-004)**: out/in linked + mutually discoverable; cross-tenant destination ⇒ safe-404.
- **Stock count (SC-005)**: count ⇒ correction movement == variance; on-hand == counted; history unchanged.
- **Tenant isolation (SC-006)**: cross-tenant/cross-store sweep ⇒ safe-404; **RLS-bypass probe** (wrong-tenant GUC) ⇒ zero rows on the new table.
- **Object safety (SC-007 / FR-052)**: mass-assignment of `tenant_id`/`store_id`/`created_by`/derived balance ignored; strict boundary rejects unknown keys; unauthorized actor ⇒ rejected; authorized action ⇒ audit event.
- **Seam design reviews (SC-008/009)**: confirm auto-decrement and the lot/batch dimension can be added without altering the v1 movement/on-hand schema.

## 5. Local verification (mandatory before push)

```bash
# from repo root
pnpm --filter @data-pulse-2/api lint
pnpm --filter @data-pulse-2/api test -- inventory
# Docker-less local: MIGRATION_TEST_ALLOW_SKIP=1 where supported; CI runs Testcontainers
```

(If the local symlink farm / dist is stale after NTFS damage: `pnpm i --frozen-lockfile --force` then `pnpm -r run build` — restores local Jest coverage verification.)

## 6. Stop conditions

- A `[GATED]` artifact change without recorded approval → **stop and report**.
- Any flow that would require the 008 live loop → **stop**; that is the deferred follow-up (FR-060), not v1.
- A movement path that mutates the 008 sale fact or auto-creates a Tenant Catalog product → **stop**; both are forbidden (FR-023/§IX).
- Negative stock being **rejected** anywhere → **stop**; v1 is allow-and-flag (FR-024).
